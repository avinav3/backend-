const express = require("express");
const router = express.Router();
const Bid = require("../models/BidSchema");
const CarListing = require("../models/CarListing");

router.get("/bids/highest/:listing_id", async (req, res) => {
  const { listing_id } = req.params;

  try {
    const listing = await CarListing.findOne({ listing_id });
    if (!listing) {
      return res.status(404).json({ error: "Listing not found." });
    }

    const highest = await Bid.find({ listing_id: listing._id })
      .sort({ bidAmount: -1 })
      .limit(1);

    const highestBid = highest?.[0]?.bidAmount || listing.price;

    res.json({ highestBid });
  } catch (err) {
    console.error("Error fetching highest bid:", err);
    res.status(500).json({ error: "Server error while fetching bid." });
  }
});

// Place a new bid
router.post("/bids/place", async (req, res) => {
  const { listing_id, user_id, bidAmount } = req.body;

  if (!listing_id || !user_id || !bidAmount) {
    return res.status(400).json({ error: "Missing required fields." });
  }

  try {
    // ✅ Find the listing using listing_id (assuming it's a custom field)
    const listing = await CarListing.findOne({ listing_id });

    if (!listing) {
      return res.status(404).json({ error: "Listing not found." });
    }

    // ✅ Convert to MongoDB ObjectId for bid reference
    const listingObjectId = listing._id;

    const now = new Date();
    if (now > listing.auctionEndTime) {
      return res
        .status(400)
        .json({ error: "Auction has ended. Bidding is closed." });
    }

    if (listing.RentList !== "Auction") {
      return res.status(400).json({ error: "This listing is not an auction." });
    }

    if (
      parseFloat(bidAmount) <= parseFloat(listing.currentBid || listing.price)
    ) {
      return res.status(400).json({
        error:
          "Bid amount must be higher than the current bid or starting price.",
      });
    }

    // ✅ Check if the user has already placed a bid
    const existingBid = await Bid.findOne({
      listing_id: listingObjectId,
      user_id,
    });
    let savedBid;

    if (existingBid) {
      existingBid.bidAmount = bidAmount;
      savedBid = await existingBid.save();
    } else {
      const newBid = new Bid({
        listing_id: listingObjectId,
        user_id,
        bidAmount,
      });
      savedBid = await newBid.save();
    }

    // ✅ Update the current highest bid on the listing (optional but recommended)
    if (parseFloat(bidAmount) > parseFloat(listing.currentBid || 0)) {
      listing.currentBid = bidAmount;
      await listing.save();
    }

    // ✅ Fetch latest highest bid
    const highest = await Bid.find({ listing_id: listingObjectId })
      .sort({ bidAmount: -1 })
      .limit(1);

    const highestBidAmount = highest?.[0]?.bidAmount || listing.price;

    res.status(201).json({
      message: "Bid placed successfully",
      bid: savedBid,
      highestBid: highestBidAmount,
    });
  } catch (err) {
    console.error("Error placing bid:", err);
    res.status(500).json({ error: "Server error while placing bid." });
  }
});

router.post("/bids/finalize-auction/:listing_id", async (req, res) => {
  const { listing_id } = req.params;

  try {
    const listing = await CarListing.findOne({ listing_id: Number(listing_id) })
      .populate("winner.user_id", "name email")
      .exec();

    if (!listing) {
      return res.status(404).json({ error: "Listing not found." });
    }

    const now = new Date();
    if (now < listing.auctionEndTime) {
      return res.status(400).json({ error: "Auction is still active." });
    }

    if (listing.winner && listing.winner.user_id) {
      return res.status(200).json({
        message: "Auction already finalized.",
        winner: listing.winner,
      });
    }

    const highest = await Bid.find({ listing_id: listing._id })
      .sort({ bidAmount: -1 })
      .limit(1);

    if (highest.length === 0) {
      listing.winner = null; // Optional: explicitly set to null
      await listing.save();
      return res.status(200).json({ message: "No bids placed." });
    }

    const winningBid = highest[0];
    listing.winner = {
      user_id: winningBid.user_id,
      bidAmount: winningBid.bidAmount,
    };

    await listing.save();

    // Fetch the updated listing with populated winner
    const updatedListing = await CarListing.findOne({
      listing_id: Number(listing_id),
    })
      .populate("winner.user_id", "name email")
      .exec();

    res.status(200).json({
      message: "Auction finalized",
      winner: updatedListing.winner,
    });
  } catch (err) {
    console.error("Error finalizing auction:", err);
    res.status(500).json({ error: "Server error while finalizing auction." });
  }
});

module.exports = router;
