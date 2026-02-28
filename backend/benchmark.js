const fs = require('fs');
const path = require('path');

function logInteractionSync(chatId, type, content) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] Chat: ${chatId} | ${type}: ${content}\n`;
  fs.appendFileSync(path.join(__dirname, 'interactions_bench.log'), logEntry);
}

function logInteractionAsync(chatId, type, content) {
  const timestamp = new Date().toISOString();
  const logEntry = `[${timestamp}] Chat: ${chatId} | ${type}: ${content}\n`;
  fs.appendFile(path.join(__dirname, 'interactions_bench.log'), logEntry, (err) => {
    if (err) console.error(err);
  });
}

function runBenchmark() {
  const iterations = 10000;

  // Cleanup
  try { fs.unlinkSync(path.join(__dirname, 'interactions_bench.log')); } catch (e) {}

  console.log(`Running benchmark with ${iterations} iterations...`);

  // Measure sync
  let startSync = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    logInteractionSync('test-chat-sync', 'BENCHMARK', `Message ${i}`);
  }
  let endSync = process.hrtime.bigint();
  let syncTimeMs = Number(endSync - startSync) / 1000000;
  console.log(`Synchronous (Baseline): ${syncTimeMs.toFixed(2)} ms`);

  // Cleanup
  try { fs.unlinkSync(path.join(__dirname, 'interactions_bench.log')); } catch (e) {}

  // Measure async
  let startAsync = process.hrtime.bigint();
  for (let i = 0; i < iterations; i++) {
    logInteractionAsync('test-chat-async', 'BENCHMARK', `Message ${i}`);
  }
  let endAsync = process.hrtime.bigint();
  let asyncTimeMs = Number(endAsync - startAsync) / 1000000;

  console.log(`Asynchronous (Optimized): ${asyncTimeMs.toFixed(2)} ms`);
  console.log(`Performance Improvement: ${((syncTimeMs - asyncTimeMs) / syncTimeMs * 100).toFixed(2)}% faster (in terms of main thread blocking time)`);

  // Wait a bit to let async writes finish before exiting
  setTimeout(() => {
    try { fs.unlinkSync(path.join(__dirname, 'interactions_bench.log')); } catch (e) {}
    console.log('Benchmark finished.');
  }, 1000);
}

runBenchmark();
