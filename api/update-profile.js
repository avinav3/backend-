//api/update-profile.js
const express = require("express");
const path = require("path");
const Users = require("../models/Users");
const {
  profileUpload,
  acceptedProfileImageFields,
} = require("../middleware/profileUpload");
const { authenticateAccessToken, requireAdmin } = require("../middleware/auth");

const router = express.Router();

function buildUserResponse(user) {
  return {
    id: user._id,
    name: user.name,
    email: user.email,
    mobile: user.mobile,
    createdAt: user.createdAt,
    lastLogin: user.lastLogin,
    role: user.role,
    status: user.status,
    profileImage: user.profileImage,
  };
}

function resolveProfileImagePath(file) {
  return path.posix.join("/uploads", "profiles", file.filename);
}

function getUploadedProfileImageFile(req) {
  if (req.file) {
    return req.file;
  }

  for (const field of acceptedProfileImageFields) {
    const file = req.files?.[field.name]?.[0];

    if (file) {
      return file;
    }
  }

  return null;
}

// ## Keep profile reads aligned with the upload response shape.
router.get("/get-profile", authenticateAccessToken, async (req, res) => {
  const targetId = req.auth.role === "admin" && req.query.id ? req.query.id : req.auth.id;

  try {
    const user = await Users.findById(
      targetId,
      "name email mobile createdAt lastLogin role status profileImage"
    );

    if (user) {
      return res.json(buildUserResponse(user));
    } else {
      return res.status(404).json({ flag: "0", message: "User not found." });
    }
  } catch (error) {
    console.error("Error fetching profile data: ", error);
    return res.status(500).json({ flag: "0", message: "Database error" });
  }
});


router.post("/update-profile", authenticateAccessToken, async (req, res) => {
  const { id, name, email, mobile } = req.body;
  const targetId = req.auth.role === "admin" && id ? id : req.auth.id;

  if (!name || !email || !mobile) {
    return res.status(400).json({ flag: "0", message: "All fields are required." });
  }

  try {
    const user = await Users.findById(targetId);
    if (user) {
      user.name = name;
      user.email = email;
      user.mobile = mobile;
      await user.save();

      return res.json({ flag: "1", message: "Profile updated successfully." });
    } else {
      return res.status(404).json({ flag: "0", message: "User not found." });
    }
  } catch (error) {
    console.error("Error updating profile: ", error);
    return res.status(500).json({ flag: "0", message: "Database error" });
  }
});

router.get("/settings", authenticateAccessToken, async (req, res) => {
  try {
    const user = await Users.findById(req.auth.id).select(
      "name email mobile createdAt lastLogin role status profileImage",
    );

    if (!user) {
      return res.status(404).json({ flag: "0", message: "User not found." });
    }

    return res.status(200).json({
      flag: "1",
      settings: buildUserResponse(user),
    });
  } catch (error) {
    console.error("Error fetching settings: ", error);
    return res.status(500).json({ flag: "0", message: "Database error" });
  }
});

async function handleSettingsUpdate(req, res) {
  const name =
    req.body.name === undefined ? undefined : String(req.body.name).trim();
  const email =
    req.body.email === undefined
      ? undefined
      : String(req.body.email).trim().toLowerCase();
  const mobile =
    req.body.mobile === undefined
      ? undefined
      : String(req.body.mobile).trim();

  if (name !== undefined && !name) {
    return res.status(400).json({ flag: "0", message: "Name cannot be empty." });
  }

  if (email !== undefined && !email) {
    return res.status(400).json({ flag: "0", message: "Email cannot be empty." });
  }

  if (mobile !== undefined && !mobile) {
    return res.status(400).json({ flag: "0", message: "Mobile cannot be empty." });
  }

  try {
    const user = await Users.findById(req.auth.id);

    if (!user) {
      return res.status(404).json({ flag: "0", message: "User not found." });
    }

    if (name !== undefined) {
      user.name = name;
    }

    if (email !== undefined) {
      user.email = email;
    }

    if (mobile !== undefined) {
      user.mobile = mobile;
    }

    await user.save();

    return res.status(200).json({
      flag: "1",
      message: "Settings updated successfully.",
      settings: buildUserResponse(user),
    });
  } catch (error) {
    console.error("Error updating settings: ", error);
    if (error?.code === 11000) {
      return res.status(409).json({
        flag: "0",
        message: "An account with this email already exists.",
      });
    }

    return res.status(500).json({ flag: "0", message: "Database error" });
  }
}

router.patch("/settings", authenticateAccessToken, handleSettingsUpdate);
router.put("/settings", authenticateAccessToken, handleSettingsUpdate);

router.post(
  "/upload-profile-image",
  authenticateAccessToken,
  (req, res, next) => {
    profileUpload.fields(acceptedProfileImageFields)(req, res, (error) => {
      if (!error) {
        return next();
      }

      if (error.code === "LIMIT_FILE_SIZE") {
        return res.status(400).json({
          flag: "0",
          message: "Profile image must be 2MB or smaller.",
        });
      }

      return res.status(400).json({
        flag: "0",
        message: error.message || "Invalid file upload.",
      });
    });
  },
  async (req, res) => {
    const targetId =
      req.auth.role === "admin" && req.body.id ? req.body.id : req.auth.id;
    const uploadedFile = getUploadedProfileImageFile(req);

    if (!uploadedFile) {
      return res.status(400).json({
        flag: "0",
        message: "Profile image file is required.",
      });
    }

    try {
      const user = await Users.findById(targetId);

      if (!user) {
        return res.status(404).json({ flag: "0", message: "User not found." });
      }

      user.profileImage = resolveProfileImagePath(uploadedFile);
      await user.save();

      return res.status(200).json({
        flag: "1",
        message: "Profile image uploaded successfully.",
        user: buildUserResponse(user),
      });
    } catch (error) {
      console.error("Error uploading profile image: ", error);
      return res.status(500).json({ flag: "0", message: "Database error" });
    }
  }
);

router.get("/get-users", authenticateAccessToken, requireAdmin, async (req, res) => {
  try {
    const users = await Users.find({}, "name email mobile role status lastLogin profileImage");
    res.status(200).json(users);
  } catch (error) {
    console.error("Error fetching users:", error);
    res.status(500).json({ message: "Failed to fetch users." });
  }
});

router.post("/suspend-user", authenticateAccessToken, requireAdmin, async (req, res) => {
  const { id } = req.body;
  try {
    const user = await Users.findById(id);
    if (user) {
      user.status = "Suspended";
      await user.save();
      res.json({ message: "User suspended successfully." });
    } else {
      res.status(404).json({ message: "User not found." });
    }
  } catch (error) {
    console.error("Error suspending user:", error);
    res.status(500).json({ message: "Failed to suspend user." });
  }
});


module.exports = router;
