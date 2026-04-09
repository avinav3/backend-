// api/change-password.js
const express = require('express');
const bcrypt = require('bcrypt');
const Users = require('../models/Users');
const { authenticateAccessToken } = require('../middleware/auth');

const router = express.Router();

router.post('/change-password', authenticateAccessToken, async (req, res) => {
  const { opass, npass, cpass } = req.body;

  if (!opass || !npass || !cpass) {
    return res.status(400).json({
      flag: "0",
      message: "Old password, new password, and confirm password are required.",
    });
  }

  if (typeof npass !== "string" || npass.length < 6) {
    return res.status(400).json({
      flag: "0",
      message: "New password must be at least 6 characters long.",
    });
  }

  if (npass !== cpass) {
    return res.status(400).json({
      flag: "0",
      message: "New password and confirm password do not match.",
    });
  }

  if (opass === npass) {
    return res.status(400).json({
      flag: "0",
      message: "New password must be different from old password.",
    });
  }

  try {
    const user = await Users.findById(req.auth.id);

    if (!user) {
      return res.status(404).json({ flag: "0", message: "User not found." });
    }

    const oldPasswordMatches = await bcrypt.compare(opass, user.password);

    if (!oldPasswordMatches) {
      return res.status(400).json({
        flag: "0",
        message: "Old password is incorrect.",
      });
    }

    const hashedPassword = await bcrypt.hash(npass, 10);
    user.password = hashedPassword;
    user.refreshToken = null;
    await user.save();

    return res.status(200).json({
      flag: "1",
      message: "Password changed successfully.",
      requireReLogin: true,
    });
  } catch (error) {
    console.error("Error changing password: ", error);
    return res.status(500).json({ flag: "0", message: "Database error" });
  }
});

module.exports = router;
