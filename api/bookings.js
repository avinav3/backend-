const express = require("express");
const router = express.Router();
const Booking = require("../models/Booking");
const User = require("../models/Users"); // Adjust path as needed
// Fetch bookings for a specific user
const CarListing = require("../models/CarListing"); // Adjust path as needed
const ServiceBooking = require("../models/serviceBooking");

const db = require("../db");
const { ObjectId } = require("mongodb");

// Create a new booking
router.post("/", async (req, res) => {
  const {
    listing_id,
    user_id,
    car_id,
    booking_start_date,
    booking_end_date,
    total_price,
    paid_price,
    booking_status,
    payment_status,
    transaction_id,
    purpose,
  } = req.body;

  // Validate the required fields
  if (
    !listing_id ||
    !user_id ||
    !car_id ||
    !booking_start_date ||
    !booking_end_date ||
    !total_price ||
    !paid_price ||
    !booking_status ||
    !payment_status ||
    !transaction_id
  ) {
    return res.status(400).json({
      message:
        "Missing required fields: listing_id, user_id, car_id, booking_start_date, booking_end_date, total_price, paid_price, transaction_id",
    });
  }

  try {
    const newBooking = new Booking({
      listing_id,
      user_id,
      car_id,
      booking_start_date,
      booking_end_date,
      total_price,
      paid_price,
      transaction_id,
      booking_status: "pending",
      payment_status: "pending",
      purpose,
    });

    const result = await newBooking.save();
    res.status(201).json(result);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/", async (req, res) => {
  try {
    // Fetch all bookings using Mongoose's `find()` method
    const bookings = await Booking.find();
    const bookingsWithUserDetails = await Promise.all(
      bookings.map(async (booking) => {
        const [carDetails, userDetails] = await Promise.all([
          CarListing.findOne(
            { listing_id: booking.car_id },
            "model fuelType carType"
          ),
          User.findOne({ _id: booking.user_id }, "name email"), // 📌 Fetch user's name and email
        ]);

        return {
          ...booking.toObject(),
          carDetails: carDetails || {},
          userDetails: userDetails || {},
        };
      })
    );

    res.status(200).json(bookingsWithUserDetails); // Return the fetched bookings as JSON
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

router.get("/uid/", async (req, res) => {
  const { user_id } = req.query;

  if (!user_id) {
    return res
      .status(400)
      .json({ message: "Missing required query parameter: user_id" });
  }

  try {
    const bookings = await Booking.find({ user_id });

    if (!bookings.length) {
      return res
        .status(404)
        .json({ message: "No bookings found for the specified user" });
    }

    const enrichedBookings = await Promise.all(
      bookings.map(async (booking) => {
        const carDetails = await CarListing.findOne(
          { listing_id: booking.car_id }, // 🔁 Match car_id with listing_id
          "model fuelType carType"
        );

        return {
          ...booking.toObject(),
          carDetails: carDetails || {},
        };
      })
    );

    res.json(enrichedBookings);
  } catch (err) {
    console.error(err);
    res.status(500).json({ message: err.message });
  }
});

// Fetch a booking by booking_id
router.get("/:id", async (req, res) => {
  try {
    const booking = await Booking.findOne({ booking_id: req.params.id });

    if (!booking) return res.status(404).json({ message: "Booking not found" });

    res.json(booking);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Update a booking by booking_id
router.put("/:id", async (req, res) => {
  try {
    const updatedBooking = await Booking.findOneAndUpdate(
      { booking_id: req.params.id },
      { $set: req.body },
      { new: true }
    );

    if (!updatedBooking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    res.json(updatedBooking);
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

// Delete a booking by booking_id
router.delete("/:id", async (req, res) => {
  try {
    const deletedBooking = await Booking.findOneAndDelete({
      booking_id: req.params.id,
    });

    if (!deletedBooking) {
      return res.status(404).json({ message: "Booking not found" });
    }

    res.json({ message: "Booking deleted successfully" });
  } catch (err) {
    res.status(500).json({ message: err.message });
  }
});

//service booking part
// Create a new service booking
router.post("/bookServicing", async (req, res) => {
  const {
    userId,
    fullName,
    contactNumber,
    email,
    vehicleBrand,
    vehicleModel,
    licensePlate,
    preferredDate,
    preferredTime,
    serviceType,
    additionalNotes,
  } = req.body;

  // Validate required fields
  if (
    !userId ||
    !fullName ||
    !contactNumber ||
    !vehicleBrand ||
    !vehicleModel ||
    !licensePlate ||
    !preferredDate ||
    !preferredTime ||
    !serviceType
  ) {
    return res.status(400).json({
      message:
        "Missing required fields. Please ensure all fields are filled correctly.",
    });
  }

  try {
    const newServiceBooking = new ServiceBooking({
      userId,
      fullName,
      contactNumber,
      email,
      vehicleBrand,
      vehicleModel,
      licensePlate,
      preferredDate,
      preferredTime,
      serviceType,
      additionalNotes,
      status: "Pending", // Default
    });

    const result = await newServiceBooking.save();

    res.status(201).json({
      message: "Service booking created successfully",
      booking: result,
    });
  } catch (err) {
    console.error("Error creating service booking:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// Example Express route for fetching service bookings
router.get("/ViewServiceBookings/:booking_id", async (req, res) => {
  try {
    const bookings = await ServiceBooking.find(); // Fetch all bookings

    if (!bookings || bookings.length === 0) {
      return res.status(404).json({ message: "No service bookings found." });
    }

    // Fetch user details for each booking
    const bookingsWithUserDetails = await Promise.all(
      bookings.map(async (booking) => {
        const user = await User.findById(booking.userId).select("name email");
        return {
          ...booking.toObject(),
          userDetails: user || {},
        };
      })
    );

    res.json(bookingsWithUserDetails);
  } catch (err) {
    console.error("Error fetching bookings:", err);
    res.status(500).json({ error: "Unable to fetch service bookings" });
  }
});

// Route to fetch service bookings for a particular user
router.get("/ViewServiceBookings/user/:userId", async (req, res) => {
  const { userId } = req.params;

  try {
    const bookings = await ServiceBooking.find({ userId }); // Filter by user_id

    if (!bookings || bookings.length === 0) {
      return res
        .status(404)
        .json({ message: "No service bookings found for this user." });
    }

    res.status(200).json(bookings);
  } catch (err) {
    console.error("Error fetching service bookings:", err);
    res.status(500).json({ error: "Unable to fetch service bookings" });
  }
});

module.exports = router;
