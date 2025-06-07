const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const walletRoutes = require("./routes/wallet");
const webhookRoutes = require("./routes/webhook");

const app = express();
app.use(cors());
app.use(bodyParser.json());

// API Routes
app.use("/api/wallet", walletRoutes);
app.use("/api/webhook", webhookRoutes);

// Start server
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});