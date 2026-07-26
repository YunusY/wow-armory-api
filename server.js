const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');
const handler = require('./api/index.js');

const app = express();
const PORT = process.env.PORT || 3000;
const reportsDir = process.env.REPORTS_DIR || path.join(os.tmpdir(), 'wow-armory-api-reports');
if (!fs.existsSync(reportsDir)) {
    fs.mkdirSync(reportsDir, { recursive: true });
}

// Serve static HTML reports directly if requested
app.use('/reports', express.static(reportsDir));

// Route for simulation API
app.get('/api/get-simc', handler);

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});