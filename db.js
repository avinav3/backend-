// db.js
const fs = require("fs");
const path = require("path");
const mongoose = require("mongoose");

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

mongoose
  .connect(uri, {
    serverSelectionTimeoutMS: 5000,
  })
  .then(() => {
    console.log("Connected to MongoDB successfully");
    console.log(`MongoDB URI: ${uri}`);
  })
  .catch((error) => {
    console.error("Error connecting to MongoDB:", error.message);
    console.error(
      "Check whether MongoDB is running, whether MONGO_URI is correct, and whether authentication/network access is configured properly."
    );
  });

mongoose.connection.on("connected", () => {
  console.log("Mongoose connected to db");
});

mongoose.connection.on("error", (err) => {
  console.error("Mongoose connection error:", err.message);
});

mongoose.connection.on("disconnected", () => {
  console.log("Mongoose disconnected");
});

module.exports = mongoose;
