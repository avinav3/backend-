const fs = require("fs");
const path = require("path");
const multer = require("multer");

const uploadsDirectory = path.join(__dirname, "..", "uploads", "profiles");

// ## Ensure the profile upload directory exists before multer writes files.
if (!fs.existsSync(uploadsDirectory)) {
  fs.mkdirSync(uploadsDirectory, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, uploadsDirectory);
  },
  filename: (_req, file, cb) => {
    const safeOriginalName = file.originalname.replace(/\s+/g, "-");
    cb(null, `${Date.now()}-${safeOriginalName}`);
  },
});

function fileFilter(_req, file, cb) {
  if (!file.mimetype || !file.mimetype.startsWith("image/")) {
    return cb(new Error("Only image files are allowed."));
  }

  return cb(null, true);
}

const profileUpload = multer({
  storage,
  fileFilter,
  limits: {
    fileSize: 2 * 1024 * 1024,
  },
});

const acceptedProfileImageFields = [
  { name: "profileImage", maxCount: 1 },
  { name: "image", maxCount: 1 },
  { name: "file", maxCount: 1 },
  { name: "avatar", maxCount: 1 },
];

module.exports = {
  profileUpload,
  acceptedProfileImageFields,
};
