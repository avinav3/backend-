//api/register.js
const express = require("express");
const bcrypt = require("bcrypt");
const { connectWithRetry, isDatabaseConnected } = require("../db");
const Users = require("../models/Users");

const router = express.Router();

router.post("/register", async (req, res) => {
  const name = String(req.body.name || "").trim();
  const email = String(req.body.email || "").trim().toLowerCase();
  const mobile =
    String(
      req.body.mobileno ||
      req.body.mobile ||
      req.body.mobileNo ||
      ""
    ).trim();
  const password = String(req.body.password || "");
  const role = req.body.role || "user";

  if (!name || !email || !mobile || !password) {
    return res.status(400).json({ message: "All fields are required." });
  }

  if (!["user", "staff", "admin"].includes(role)) {
    return res.status(400).json({ message: "Invalid role specified." });
  }

  if (!isDatabaseConnected()) {
    await connectWithRetry();
  }

  if (!isDatabaseConnected()) {
    return res.status(503).json({
      message: "Database is unavailable. Please try again later.",
    });
  }

  try {
    const existingUser = await Users.findOne({ email });

    if (existingUser) {
      return res.status(409).json({
        message: "An account with this email already exists.",
      });
    }

    const hashedPassword = await bcrypt.hash(password, 10);
    const users = new Users({
      name,
      email,
      mobile,
      password: hashedPassword,
      role,
      status: "active",
    });

    await users.save();
    res.status(200).json({ message: "Registration successful." });
  } catch (error) {
    console.error("Error during registration: ", error);
    if (error?.code === 11000) {
      return res.status(409).json({
        message: "An account with this email already exists.",
      });
    }

    if (error?.name === "ValidationError") {
      return res.status(400).json({
        message: "Registration data is invalid.",
      });
    }

    res.status(500).json({ message: "Registration failed." });
  }
});

module.exports = router;
