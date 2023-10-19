import { AptosClient, AptosAccount, CoinClient } from "aptos";
import { HttpsProxyAgent } from 'https-proxy-agent';
import fetch from 'node-fetch';
import { Buffer } from "buffer";
import { config } from "./config.js";
import consoleStamp from 'console-stamp';
import fs from 'fs'

consoleStamp(console, { format: ':date(HH:MM:ss)' });

const parseFile = fileName => fs.readFileSync(fileName, "utf8").split('\n').map(str => str.trim()).filter(str => str.length > 10);
const generateRandomNumber = (min, max) => Math.round(Math.random() * (max - min) + min);
const timeout = ms => new Promise(res => setTimeout(res, ms))

const client = new AptosClient(config.rpc);
const coinClient = new CoinClient(client)
const retriesMap = new Map();

function handleRetries(address) {
    let maxRetries = config.retries;
    let count = retriesMap.get(address) + 1 || 1;
    retriesMap.set(address, count);

    return count < maxRetries
}

async function submitTransactionProxy(signedTxn, proxy) {
    const headers = { 'Content-Type': 'application/x.aptos.signed_transaction+bcs' };
    const proxyAgent = new HttpsProxyAgent(proxy);
    const requestOptions = {
        method: 'POST',
        headers: headers,
        body: signedTxn,
        agent: proxyAgent,
    };
    
    try {
        const response = await fetch(`${config.rpc}/transactions`, requestOptions);
    
        if (response.status >= 400) {
          const errorText = await response.text();
          throw new Error(`ApiError: ${errorText}, Status Code: ${response.status}`);
        }
    
        const responseData = await response.json();
        return responseData;
      } catch (error) {
        throw error;
      }
}

async function getTransactionByHash(txnHash, proxy) {
    const proxyAgent = new HttpsProxyAgent(proxy);
    const requestOptions = {
        method: 'GET',
        agent: proxyAgent,
    };
    const response = await fetch(`${config.rpc}/transactions/by_hash/${txnHash}`, requestOptions);
    if (response.status != 404 && response.status >= 400) {
      throw new Error(`ApiError: ${response.status}`);
    }
    return await response.json();
  }

async function transactionPendingProxy(txnHash, proxy) {
    const response = await getTransactionByHash(txnHash, proxy);
    if (response.status === 404) {
        return true;
    }
    if (response.status >= 400) {
        throw new Error(`ApiError: ${response.text}, Status Code: ${response.status}`);
    }
    return response.type === 'pending_transaction';
}

async function waitForTransactionProxy(txnHash, proxy) {
    let count = 0;
    let response;

    while (await transactionPendingProxy(txnHash, proxy)) {
        if (count >= 50) {
            throw new Error(`Transaction ${txnHash} timed out`);
        }
        await timeout(1000)
        count++;
    }

    response = await getTransactionByHash(txnHash, proxy);
    count = 0;
    while (!response.success) {
        if (count >= 50) {
            throw new Error(`Transaction ${txnHash} timed out`);
        }
        response = await getTransactionByHash(txnHash, proxy);
        await timeout(1000)
        count++;
    }
    if (!response.success) {
        throw new Error(`${response.text} - ${txnHash}`);
    }
    return response
}

async function sendTransaction(sender, payload, proxy) {
    try {
        const txnRequest = await client.generateTransaction(sender.address(), payload, {
            max_gas_amount: generateRandomNumber(700, 2000),
        });

        const signedTxn = await client.signTransaction(sender, txnRequest);

        const transactionRes = await submitTransactionProxy(signedTxn, proxy);

        let txnHash = transactionRes?.hash

        console.log(`tx: https://explorer.aptoslabs.com/txn/${txnHash}?network=mainnet`);

        let status = await waitForTransactionProxy(txnHash, proxy)
    } catch (err) {
        try {
            console.log('[ERROR]', JSON.parse(err?.message).message)
        } catch { console.log('[ERROR]', err.message) }

        if (handleRetries(sender.address().toString())) {
            await timeout(10000)
            return await sendTransaction(sender, payload)
        }
    }
}


async function enable_nft(sender, proxy) {
    console.log(`Start enable nft`);

    return await sendTransaction(
        sender, {
            function: "0x3::token::opt_in_direct_transfer",
            type_arguments: [],
            arguments: [
                true,
            ],
        }, 
        proxy
    )
}

async function checkBalance(account) {
    try {
        let balance = Number(await coinClient.checkBalance(account)) / 100000000;
        console.log(`Balance ${balance} APT`);

        return balance
    } catch (err) {
        try {
            if (JSON.parse(err?.message).message.includes('Resource not found')) {
                console.log(`Balance 0 APT`);
                return 0
            } else console.log('[ERROR]', JSON.parse(err?.message).message)
        } catch {
            console.log('[ERROR]', err.message)
        }

        if (handleRetries(sender.address().toString())) {
            await timeout(2000)
            return await checkBalance(account)
        }
    }
}

(async () => {
    let privateKeys = parseFile('wallets.txt');
    let proxies = parseFile('proxy.txt');
    let i = 0;

    while (i < privateKeys.length) {
        let pk = privateKeys[i]
        let proxy = proxies[i]

        if (!proxy.includes('://')) {
            proxy = 'http://' + proxy
        }

        if (pk.startsWith('0x'))
            pk = pk.slice(2, pk.length);

        const account = new AptosAccount(Uint8Array.from(Buffer.from(pk, 'hex')));
        const balance = await checkBalance(account)

        console.log(account.address().hex());

        if (balance > 0) {
            await enable_nft(account, proxy);
            console.log("-".repeat(130));
            await timeout(config.sleep)
        }

        i++;
    }
})()
