const config = require('./config');
const Web3 = require('web3');
const redis = require("redis");
const getRedisFunctions = require("./functions/createRedis");
const {initMQ} = require("./functions/initMQ");
const {processBlockForEvent} = require("./functions/processBlockForEvent")
const eventNames = ["DepositEvent", "ExitStartedEvent", "DepositWithdrawStartedEvent"];

async function startBlockProcessing() {
    // init MQ and start the loop
    console.log("Creating redis")
    console.log(JSON.stringify(config.redis));
    const redisClient = redis.createClient(config.redis);
    console.log("Initializing message queue")
    const mq = await initMQ(config.redis, eventNames)
    console.log("Getting the block number to start with")
    const redisFunctions = getRedisFunctions(redisClient);
    const {redisGet, redisSet, redisExists} = redisFunctions;
    let exists = await redisExists("fromBlock");
    if (!exists) {
        console.log("Writing default starting block " + config.fromBlock)
        await redisSet("fromBlock", config.fromBlock)
    }
    let fromBlock = await redisGet("fromBlock");
    console.log("Last processed block from persistance is " + fromBlock)
    fromBlock = Number.parseInt(fromBlock, 10);
    if (fromBlock === undefined || isNaN(fromBlock)) {
        console.log("Fallback, starting from block 1")
        // fromBlock = Number.parseInt(config.fromBlock, 10);
        fromBlock = 1
    }
    console.log("Getting contract details")
    const contractDetails = await config.contractDetails();
    const web3 = new Web3(config.ethNodeAddress);
    const PlasmaContract = new web3.eth.Contract(contractDetails.abi, contractDetails.address);
    console.log("Starting from block " + fromBlock)

    processBlockForEvents(fromBlock)().then((_dispose) => {
        console.log("Started block processing loop");
    });

    function processBlockForEvents(previousBlockNumber) {
        return async function() {
            try{
                let lastblock = await web3.eth.getBlockNumber();
                // console.log("Last Ethereum block " + lastblock)
                if (lastblock > previousBlockNumber) {
                    lastblock = previousBlockNumber + 1;
                    let blockToProcess = lastblock - config.blocks_shift;
                    if (blockToProcess <= 1) {
                        blockToProcess = 1
                    }
                    console.log("Processing block " + blockToProcess);
                    await processBlock(blockToProcess)();
                    await redisSet("fromBlock", lastblock);
                    setTimeout(processBlockForEvents(lastblock), 1000);
                    return;
                } else {
                    setTimeout(processBlockForEvents(lastblock), 10000);
                    return;
                }
            }
            catch(error) {
                console.log("Error processing block for events : " + error);
                if (error.name == "Submitting too far in future") {
                    setImmediate(processBlock(error.message));
                    return;
                }
                setImmediate(processBlockForEvents(previousBlockNumber));
            }
        }
    }

    function processBlock(blockNumber) {
        return async function() {
            for (const eventName of eventNames) {
                const numProcessed = await processBlockForEvent(blockNumber, eventName, PlasmaContract, mq)
                console.log("Processed " + numProcessed + " of events " + eventName + " in block " + blockNumber)
            }
        }
    }
}

startBlockProcessing().catch(err => { console.log(err); process.exit(1); });