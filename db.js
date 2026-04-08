// db.js
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

mongoose.set("bufferCommands", false);

const DEFAULT_RETRY_DELAY_MS = Number(process.env.MONGO_RETRY_DELAY_MS || 5000);
let reconnectTimer = null;
let isConnecting = false;

function loadEnvFile() {
  const envPath = path.join(__dirname, ".env");

  if (!fs.existsSync(envPath)) {
    return;
  }

  const envContent = fs.readFileSync(envPath, "utf8");

  envContent.split(/\r?\n/).forEach((line) => {
    const trimmedLine = line.trim();

    if (!trimmedLine || trimmedLine.startsWith("#")) {
      return;
    }

    const separatorIndex = trimmedLine.indexOf("=");

    if (separatorIndex === -1) {
      return;
    }

    const key = trimmedLine.slice(0, separatorIndex).trim();
    const value = trimmedLine.slice(separatorIndex + 1).trim();

    if (key && process.env[key] === undefined) {
      process.env[key] = value;
    }
  });
}

loadEnvFile();

const uri = process.env.MONGO_URI || "mongodb://127.0.0.1:27017/carRental";

function isDatabaseConnected() {
  return mongoose.connection.readyState === 1;
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function scheduleReconnect() {
  if (reconnectTimer || isDatabaseConnected() || isConnecting) {
    return;
  }

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectWithRetry();
  }, DEFAULT_RETRY_DELAY_MS);

  if (typeof reconnectTimer.unref === "function") {
    reconnectTimer.unref();
  }
}

async function connectWithRetry() {
  if (isConnecting || isDatabaseConnected()) {
    return;
  }

  isConnecting = true;

  try {
    await mongoose.connect(uri, {
      serverSelectionTimeoutMS: 5000,
    });

    clearReconnectTimer();
    console.log("Connected to MongoDB successfully");
    console.log(`MongoDB URI: ${uri}`);
  } catch (error) {
    console.error("Error connecting to MongoDB:", error.message);
    console.error(
      "Check whether MongoDB is running, whether MONGO_URI is correct, and whether authentication/network access is configured properly.",
    );
    scheduleReconnect();
  } finally {
    isConnecting = false;
  }
}

connectWithRetry();

mongoose.connection.on("connected", () => {
  clearReconnectTimer();
  console.log("Mongoose connected to db");
});

mongoose.connection.on("error", (err) => {
  console.error("Mongoose connection error:", err.message);
});

mongoose.connection.on("disconnected", () => {
  console.log("Mongoose disconnected");
  scheduleReconnect();
});

module.exports = {
  mongoose,
  isDatabaseConnected,
  connectWithRetry,
};
