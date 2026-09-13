// Vivacada — single entry point for all runtime modes.
// APP_MODE=testing    -> the self-hosted, human-proctored exam kiosk (testing-app/)
// APP_MODE=aggregator -> the hosted registry: accounts, catalog, credentials (aggregator/)
// APP_MODE=ai-testing -> the hosted, payment-gated, AI-proctored exam service (ai-testing-app/)
// APP_MODE=employer   -> the hosted employer self-serve portal (employer-app/)
require('dotenv').config();

const MODE = (process.env.APP_MODE || 'testing').toLowerCase();

if (MODE === 'aggregator') {
  require('./aggregator/server.js');
} else if (MODE === 'testing') {
  require('./testing-app/server.js');
} else if (MODE === 'ai-testing') {
  require('./ai-testing-app/server.js');
} else if (MODE === 'employer') {
  require('./employer-app/server.js');
} else {
  console.error(`[vivacada] Unknown APP_MODE "${MODE}". Set APP_MODE to "testing", "aggregator", "ai-testing", or "employer" in .env.`);
  process.exit(1);
}
