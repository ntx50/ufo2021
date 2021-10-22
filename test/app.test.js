const fs = require('fs');
const BN = require('bn.js');
const nearAPI = require('near-api-js');
const testUtils = require('./test-utils');
const getConfig = require('../src/config');

const {
	Contract, KeyPair, Account,
	utils: { format: { parseNearAmount } },
	transactions: { deployContract, functionCall },
} = nearAPI;
const {
	connection, initContract, getAccount, getAccountBalance,
	contract, contractAccount, contractName, contractMethods, createAccessKeyAccount,
	createOrInitAccount,
	getContract,
} = testUtils;
const {
	networkId, GAS, GUESTS_ACCOUNT_SECRET
} = getConfig();

jasmine.DEFAULT_TIMEOUT_INTERVAL = 60000;

// this is used in creating the marketplace, tracks bids up to 3 most recent, default is 1
const BID_HISTORY_LENGTH = 3;
const DELIMETER = '||';

const now = Date.now();
const tokenTypes = [
	// one unique type
	`typeA:${now}`,
	// 2 tokens of same type
	`typeB:${now}`,
	`typeB:${now}`,
];
const tokenIds = tokenTypes.map((type, i) => `${type}:${i}`);
const contract_royalty = 500;

const metadata = {
	media: 'https://media.giphy.com/media/h2ZVjT3kt193cxnwm1/giphy.gif',
	issued_at: now.toString()
};
const metadata2 = {
	media: 'https://media.giphy.com/media/laUY2MuoktHPy/giphy.gif',
	issued_at: now.toString()
};

/// contractAccount.accountId is the NFT contract and contractAccount is the owner
/// see initContract in ./test-utils.js for details
const contractId = contractAccount.accountId;
console.log('\n\n contractId:', contractId, '\n\n');
/// the test fungible token
const fungibleId = 'fungible.' + contractId;
/// the market contract
const marketId = 'market.' + contractId;

describe('deploy contract ' + contractName, () => {

	let alice, aliceId, bob, bobId,
		fungibleAccount, marketAccount,
		storageMinimum, storageMarket;

	/// most of the following code in beforeAll can be used for deploying and initializing contracts
	/// skip tests if you want to deploy to production or testnet without any NFTs
	beforeAll(async () => {
		await initContract();

		/// some users
		aliceId = 'alice-' + now + '.' + contractId;
		alice = await getAccount(aliceId);
		console.log('\n\n Alice accountId:', aliceId, '\n\n');

		bobId = 'bob-' + now + '.' + contractId;
		bob = await getAccount(bobId);
		console.log('\n\n Bob accountId:', bobId, '\n\n');

		// set contract royalty to 5%
		await contractAccount.functionCall({
			contractId: contractName,
			methodName: 'set_contract_royalty',
			args: { contract_royalty },
			gas: GAS
		});

		// set token types and hard supply caps
		const supply_cap_by_type = {
			[tokenTypes[0]]: '1',
			[tokenTypes[1]]: '500',
		};
		await contractAccount.functionCall({
			contractId,
			methodName: 'add_token_types',
			args: {
				supply_cap_by_type,
				locked: true,
			},
			gas: GAS
		});

		/// create or get fungibleAccount and deploy ft.wasm (if not already deployed)
		fungibleAccount = await createOrInitAccount(fungibleId, GUESTS_ACCOUNT_SECRET);
		const fungibleAccountState = await fungibleAccount.state();
		console.log('\n\n state:', fungibleAccountState, '\n\n');
		if (fungibleAccountState.code_hash === '11111111111111111111111111111111') {
			const fungibleContractBytes = fs.readFileSync('./out/ft.wasm');
			console.log('\n\n deploying fungibleAccount contractBytes:', fungibleContractBytes.length, '\n\n');
			const newFungibleArgs = {
				/// will have totalSupply minted to them
				owner_id: contractId,
				total_supply: parseNearAmount('1000000'),
				name: 'Test Fungible T',
				symbol: 'TFT',
				// not set by user request
				version: '1',
				reference: 'https://github.com/near/core-contracts/tree/master/w-near-141',
				reference_hash: '7c879fa7b49901d0ecc6ff5d64d7f673da5e4a5eb52a8d50a214175760d8919a',
				decimals: 24,
			};
			const actions = [
				deployContract(fungibleContractBytes),
				functionCall('new', newFungibleArgs, GAS)
			];
			await fungibleAccount.signAndSendTransaction({ receiverId: fungibleId, actions });
			/// find out how much needed to store for FTs
			storageMinimum = await contractAccount.viewFunction(fungibleId, 'storage_minimum_balance');
			console.log('\n\n storageMinimum:', storageMinimum, '\n\n');
			/// pay storageMinimum for all the royalty receiving accounts
			const promises = [];
			for (let i = 1; i < 6; i++) {
				promises.push(fungibleAccount.functionCall({
					contractId: fungibleId,
					methodName: 'storage_deposit',
					args: { account_id: `a${i}.testnet` },
					gas: GAS,
					attachedDeposit: storageMinimum
				}));
			}
			await Promise.all(promises);
		} else {
			/// find out how much needed to store for FTs
			storageMinimum = await contractAccount.viewFunction(fungibleId, 'storage_minimum_balance');
			console.log('\n\n storageMinimum:', storageMinimum, '\n\n');
		}

		/** 
		 * Deploy the Market Contract and connect it to the NFT contract (contractId)
		 * and the FT contract (fungibleAccount.[contractId])
		 */

		/// default option for markets, init with all FTs you want it to support
		const ft_token_ids = [fungibleId];

		/// create or get market account and deploy market.wasm (if not already deployed)
		marketAccount = await createOrInitAccount(marketId, GUESTS_ACCOUNT_SECRET);
		const marketAccountState = await marketAccount.state();
		console.log('\n\nstate:', marketAccountState, '\n\n');
		if (marketAccountState.code_hash === '11111111111111111111111111111111') {

			const marketContractBytes = fs.readFileSync('./out/market.wasm');
			console.log('\n\n deploying marketAccount contractBytes:', marketContractBytes.length, '\n\n');
			const newMarketArgs = {
				owner_id: contractId,
				ft_token_ids,
				bid_history_length: BID_HISTORY_LENGTH,
			};
			const actions = [
				deployContract(marketContractBytes),
				functionCall('new', newMarketArgs, GAS)
			];
			await marketAccount.signAndSendTransaction({ receiverId: marketId, actions });

			/// NOTE market must register for all ft_token_ids it wishes to use (e.g. use this loop for standard fts)
			
			ft_token_ids.forEach(async (ft_token_id) => {
				const deposit = await marketAccount.viewFunction(ft_token_id, 'storage_minimum_balance');
				await marketAccount.functionCall({
					contractId: ft_token_id,
					methodName: 'storage_deposit',
					args: {},
					gas: GAS,
					attachedDeposit: deposit
				});
			});
		}
		// get all supported tokens as array
		const supportedTokens = await marketAccount.viewFunction(marketId, 'supported_ft_token_ids');
		console.log('\n\n market supports these fungible tokens:', supportedTokens, '\n\n');

		// should be [false], just testing api
		const added = await contractAccount.functionCall({
			contractId: marketId,
			methodName: 'add_ft_token_ids',
			args: { ft_token_ids },
			gas: GAS,
		});
		console.log('\n\n added these tokens', supportedTokens, '\n\n');

		/// find out how much needed for market storage
		storageMarket = await contractAccount.viewFunction(marketId, 'storage_amount');
		console.log('\n\n storageMarket:', storageMarket, '\n\n');
	});

});