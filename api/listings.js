const express = require("express");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const CarListing = require("../models/CarListing"); // Path to CarListing model
const User = require("../models/Users"); // Path to User model
const mongoose = require("mongoose");
const Review = require("../models/Review");
const TestDrive = require("../models/TestDrive"); // adjust path if needed
const router = express.Router();

// Set up storage engine for multer
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, "../uploads");
    if (!fs.existsSync(uploadPath)) {
      fs.mkdirSync(uploadPath, { recursive: true });
    }
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = `${Date.now()}-${Math.round(Math.random() * 1e9)}`;
    cb(null, `${uniqueSuffix}-${file.originalname}`);
  },
});

// File filter to allow only images
const fileFilter = (req, file, cb) => {
  if (file.mimetype.startsWith("image/")) {
    cb(null, true);
  } else {
    cb(new Error("Only image files are allowed!"), false);
  }
};

const upload = multer({
  storage,
  fileFilter,
  limits: { fileSize: 5 * 1024 * 1024 }, // 5 MB file size limit
}).array("images", 5);

router.post("/listings", upload, async (req, res) => {
  try {
    const imageFiles = req.files;
    if (!imageFiles || imageFiles.length === 0) {
      return res
        .status(400)
        .json({ message: "At least one image file is required" });
    }

    const imagePaths = imageFiles.map((file) => ({
      url: `/uploads/${file.filename}`,
      filename: file.filename,
    }));

    const newCarListing = new CarListing({
      ...req.body,
      images: imagePaths,
      auctionEndTime:
        req.body.RentList === "Auction"
          ? new Date(Date.now() + 2 * 60 * 1000)
          : null,
    });

    const savedListing = await newCarListing.save();
    res.status(201).json(savedListing);
  } catch (error) {
    console.error("Error creating listing:", error);
    res.status(500).json({
      message: "Error creating listing",
      error: error.message,
    });
  }
});

// Get all car listings
router.get("/listings", async (req, res) => {
  try {
    const listings = await CarListing.find();
    res.status(200).json(listings);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/listings/:id", async (req, res) => {
  try {
    const listingId = req.params.id;

    // Fetch car listing
    const listing = await CarListing.findOne({ listing_id: listingId });
    if (!listing) {
      return res.status(404).json({ message: "Listing not found" });
    }

    // Calculate average rating
    const reviews = await Review.find({ car_id: listingId });
    const averageRating = reviews.length
      ? reviews.reduce((sum, r) => sum + r.rating, 0) / reviews.length
      : null;

    res.status(200).json({ ...listing._doc, averageRating });
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

router.put("/listings/:id", upload, async (req, res) => {
  try {
    const listingId = req.params.id;

    // Find the listing by listing_id (not _id)
    const listing = await CarListing.findOne({ listing_id: listingId });
    if (!listing) {
      return res.status(404).json({ message: "Listing not found" });
    }

    // If new images are uploaded, handle them
    const imageFiles = req.files;
    if (imageFiles && imageFiles.length > 0) {
      // Delete old images from the server
      if (listing.images && listing.images.length > 0) {
        listing.images.forEach((image) => {
          const imagePath = path.join(__dirname, "../uploads", image.filename);
          if (fs.existsSync(imagePath)) {
            fs.unlinkSync(imagePath);
          }
        });
      }

      // Update with new image paths
      const newImages = imageFiles.map((file) => ({
        url: `/uploads/${file.filename}`,
        filename: file.filename,
      }));
      req.body.images = newImages;
    }

    // Update listing fields
    const updatedFields = {
      ...req.body,
      date_updated: Date.now(),
    };

    const updatedListing = await CarListing.findOneAndUpdate(
      { listing_id: listingId },
      { $set: updatedFields },
      { new: true }
    );

    res.status(200).json(updatedListing);
  } catch (error) {
    console.error("Error updating listing:", error);
    res.status(500).json({
      message: "Error updating listing",
      error: error.message,
    });
  }
});

// Update Car Status
router.put("/listings/:id", async (req, res) => {
  try {
    const { listing_status } = req.body;

    if (!listing_status) {
      return res.status(400).json({ error: "Car status is required" });
    }

    const listing = await listing.findByIdAndUpdate(
      req.params.id,
      { listing_status },
      { new: true, runValidators: true }
    );

    if (!listing) {
      return res.status(404).json({ error: "Listing not found" });
    }

    res
      .status(200)
      .json({ message: "Car status updated successfully", listing });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Delete a car listing by ID
router.delete("/listings/:id", async (req, res) => {
  try {
    const deletedListing = await CarListing.findByIdAndDelete(req.params.id);
    if (!deletedListing) {
      return res.status(404).json({ message: "Listing not found" });
    }

    // Delete associated image file if it exists
    if (deletedListing.image && deletedListing.image.filename) {
      const imagePath = path.join(
        __dirname,
        "../uploads",
        deletedListing.image.filename
      );
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }

    res.status(204).send();
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.post("/test-drives/schedule/:car_id", async (req, res) => {
  const { car_id } = req.params;
  const { date, time, location, user_id } = req.body;

  if (!date?.trim() || !time?.trim() || !location?.trim()) {
    return res.status(400).json({ error: "All fields are required." });
  }

  try {
    const testDrive = new TestDrive({
      car_id: parseInt(car_id),
      user_id: user_id || null, // optional
      preferred_date: new Date(date),
      preferred_time: time,
      preferred_location: location,
    });

    await testDrive.save();

    res.status(201).json({
      message: "Test drive scheduled successfully",
      data: testDrive,
    });
  } catch (err) {
    console.error("Error saving test drive:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// Route to fetch all scheduled test drives

router.get("/test-drives/user/:user_id", async (req, res) => {
  const { user_id } = req.params;

  try {
    const testDrives = await TestDrive.find({ user_id });

    if (!testDrives.length) {
      return res
        .status(404)
        .json({ message: "No test drives found for this user." });
    }

    // Fetch car details for each test drive
    const testDrivesWithCarDetails = await Promise.all(
      testDrives.map(async (testDrive) => {
        const carDetails = await CarListing.findOne(
          { listing_id: testDrive.car_id }, // 🔁 Match car_id with listing_id
          "model fuelType carType"
        );
        return {
          ...testDrive.toObject(),
          carDetails: carDetails || {},
        };
      })
    );

    res.status(200).json(testDrivesWithCarDetails);
  } catch (err) {
    console.error("Error fetching user test drives:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// 🛠 Route to get all test drives (for staff)
router.get("/test-drives", async (req, res) => {
  try {
    const testDrives = await TestDrive.find(); // 🚀 No filtering by user_id

    if (!testDrives.length) {
      return res.status(404).json({ message: "No test drives found." });
    }

    // Fetch car details for each test drive
    const testDrivesWithDetails = await Promise.all(
      testDrives.map(async (testDrive) => {
        const [carDetails, userDetails] = await Promise.all([
          CarListing.findOne(
            { listing_id: testDrive.car_id },
            "model fuelType carType"
          ),
          User.findOne({ _id: testDrive.user_id }, "name email"), // 📌 Fetch user's name and email
        ]);

        return {
          ...testDrive.toObject(),
          carDetails: carDetails || {},
          userDetails: userDetails || {},
        };
      })
    );

    res.status(200).json(testDrivesWithDetails);
  } catch (err) {
    console.error("Error fetching all test drives:", err);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

module.exports = router;
