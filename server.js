const express = require('express');
const mongoose = require('mongoose');
const cors = require('cors');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const Razorpay = require('razorpay');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// MongoDB Connection
mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fantasy_app', {
    useNewUrlParser: true,
    useUnifiedTopology: true
});

// Razorpay Instance
const razorpay = new Razorpay({
    key_id: process.env.RAZORPAY_KEY_ID,
    key_secret: process.env.RAZORPAY_KEY_SECRET
});

// User Schema
const userSchema = new mongoose.Schema({
    name: String,
    email: { type: String, unique: true },
    phone: String,
    password: String,
    balance: { type: Number, default: 0 },
    totalWinning: { type: Number, default: 0 },
    totalContests: { type: Number, default: 0 },
    kycVerified: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now }
});

const User = mongoose.model('User', userSchema);

// Contest Schema
const contestSchema = new mongoose.Schema({
    matchId: String,
    name: String,
    entryFee: Number,
    prizePool: Number,
    maxTeams: Number,
    joinedTeams: { type: Number, default: 0 },
    winningBreakup: [{
        rankFrom: Number,
        rankTo: Number,
        prize: Number
    }],
    isActive: { type: Boolean, default: true },
    createdAt: { type: Date, default: Date.now }
});

const Contest = mongoose.model('Contest', contestSchema);

// Team Schema
const teamSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    contestId: { type: mongoose.Schema.Types.ObjectId, ref: 'Contest' },
    matchId: String,
    teamName: String,
    captain: String,
    viceCaptain: String,
    players: [{
        playerId: String,
        name: String,
        role: String,
        points: { type: Number, default: 0 }
    }],
    totalPoints: { type: Number, default: 0 },
    rank: Number,
    createdAt: { type: Date, default: Date.now }
});

const Team = mongoose.model('Team', teamSchema);

// Match Schema
const matchSchema = new mongoose.Schema({
    matchId: String,
    team1: String,
    team2: String,
    date: Date,
    time: String,
    venue: String,
    status: String,
    result: String
});

const Match = mongoose.model('Match', matchSchema);

// Payment Schema
const paymentSchema = new mongoose.Schema({
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    orderId: String,
    paymentId: String,
    amount: Number,
    status: { type: String, default: 'pending' },
    createdAt: { type: Date, default: Date.now }
});

const Payment = mongoose.model('Payment', paymentSchema);

// ==================== AUTH MIDDLEWARE ====================
const authenticate = async (req, res, next) => {
    try {
        const token = req.header('Authorization').replace('Bearer ', '');
        const decoded = jwt.verify(token, process.env.JWT_SECRET || 'fantasy_secret');
        const user = await User.findOne({ _id: decoded.userId });
        
        if (!user) throw new Error();
        
        req.user = user;
        req.token = token;
        next();
    } catch (error) {
        res.status(401).send({ error: 'Please authenticate' });
    }
};

// ==================== API ROUTES ====================

// 1. REGISTER USER
app.post('/api/register', async (req, res) => {
    try {
        const { name, email, phone, password } = req.body;
        
        const existingUser = await User.findOne({ email });
        if (existingUser) {
            return res.status(400).send({ error: 'User already exists' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        
        const user = new User({
            name,
            email,
            phone,
            password: hashedPassword,
            balance: 100
        });
        
        await user.save();
        
        const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'fantasy_secret');
        
        res.status(201).send({
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                balance: user.balance
            },
            token
        });
    } catch (error) {
        res.status(400).send({ error: error.message });
    }
});

// 2. LOGIN USER
app.post('/api/login', async (req, res) => {
    try {
        const { email, password } = req.body;
        
        const user = await User.findOne({ email });
        if (!user) {
            return res.status(400).send({ error: 'Invalid credentials' });
        }
        
        const isMatch = await bcrypt.compare(password, user.password);
        if (!isMatch) {
            return res.status(400).send({ error: 'Invalid credentials' });
        }
        
        const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET || 'fantasy_secret');
        
        res.send({
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                balance: user.balance,
                totalWinning: user.totalWinning
            },
            token
        });
    } catch (error) {
        res.status(400).send({ error: error.message });
    }
});

// 3. GET USER PROFILE
app.get('/api/profile', authenticate, async (req, res) => {
    try {
        const user = req.user;
        res.send({
            user: {
                id: user._id,
                name: user.name,
                email: user.email,
                phone: user.phone,
                balance: user.balance,
                totalWinning: user.totalWinning,
                totalContests: user.totalContests,
                kycVerified: user.kycVerified
            }
        });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// 4. GET LIVE MATCHES
app.get('/api/matches', async (req, res) => {
    try {
        const matches = await Match.find({ status: 'upcoming' })
            .sort({ date: 1 })
            .limit(20);
            
        res.send(matches);
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// 5. GET CONTESTS FOR MATCH
app.get('/api/contests/:matchId', async (req, res) => {
    try {
        const { matchId } = req.params;
        const contests = await Contest.find({ 
            matchId, 
            isActive: true 
        }).sort({ entryFee: 1 });
        
        res.send(contests);
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// 6. CREATE RAZORPAY ORDER
app.post('/api/create-order', authenticate, async (req, res) => {
    try {
        const { amount } = req.body;
        
        const options = {
            amount: amount * 100,
            currency: 'INR',
            receipt: `receipt_${Date.now()}`,
            payment_capture: 1
        };
        
        const order = await razorpay.orders.create(options);
        
        const payment = new Payment({
            userId: req.user._id,
            orderId: order.id,
            amount: amount,
            status: 'created'
        });
        
        await payment.save();
        
        res.send({
            orderId: order.id,
            amount: order.amount,
            currency: order.currency,
            key: process.env.RAZORPAY_KEY_ID
        });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// 7. VERIFY PAYMENT
app.post('/api/verify-payment', authenticate, async (req, res) => {
    try {
        const { orderId, paymentId } = req.body;
        
        const payment = await Payment.findOne({ orderId });
        if (payment) {
            payment.paymentId = paymentId;
            payment.status = 'completed';
            await payment.save();
            
            await User.findByIdAndUpdate(req.user._id, {
                $inc: { balance: payment.amount }
            });
            
            res.send({ success: true, message: 'Payment successful' });
        } else {
            res.status(400).send({ error: 'Payment not found' });
        }
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// 8. CREATE TEAM
app.post('/api/create-team', authenticate, async (req, res) => {
    try {
        const { contestId, matchId, teamName, players, captain, viceCaptain } = req.body;
        
        const contest = await Contest.findById(contestId);
        if (req.user.balance < contest.entryFee) {
            return res.status(400).send({ error: 'Insufficient balance' });
        }
        
        const team = new Team({
            userId: req.user._id,
            contestId,
            matchId,
            teamName,
            players,
            captain,
            viceCaptain
        });
        
        await team.save();
        
        await User.findByIdAndUpdate(req.user._id, {
            $inc: { 
                balance: -contest.entryFee,
                totalContests: 1 
            }
        });
        
        await Contest.findByIdAndUpdate(contestId, {
            $inc: { joinedTeams: 1 }
        });
        
        res.status(201).send({
            success: true,
            teamId: team._id,
            message: 'Team created successfully'
        });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// 9. GET USER TEAMS
app.get('/api/my-teams', authenticate, async (req, res) => {
    try {
        const teams = await Team.find({ userId: req.user._id })
            .populate('contestId')
            .sort({ createdAt: -1 });
            
        res.send(teams);
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// 10. GET LEADERBOARD
app.get('/api/leaderboard/:contestId', async (req, res) => {
    try {
        const { contestId } = req.params;
        
        const teams = await Team.find({ contestId })
            .populate('userId', 'name')
            .sort({ totalPoints: -1 })
            .limit(100);
            
        teams.forEach((team, index) => {
            team.rank = index + 1;
        });
        
        res.send(teams);
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// 11. WITHDRAWAL REQUEST
app.post('/api/withdraw', authenticate, async (req, res) => {
    try {
        const { amount, upiId } = req.body;
        
        if (amount < 100) {
            return res.status(400).send({ error: 'Minimum withdrawal ₹100' });
        }
        
        if (req.user.balance < amount) {
            return res.status(400).send({ error: 'Insufficient balance' });
        }
        
        await User.findByIdAndUpdate(req.user._id, {
            $inc: { balance: -amount }
        });
        
        res.send({
            success: true,
            message: 'Withdrawal request submitted. Processed within 24 hours.'
        });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

// 12. ADMIN: GET ALL USERS
app.get('/api/admin/users', authenticate, async (req, res) => {
    try {
        if (req.user.email !== 'admin@fantasy.com') {
            return res.status(403).send({ error: 'Access denied' });
        }
        
        const users = await User.find({}).sort({ createdAt: -1 });
        const totalUsers = await User.countDocuments();
        const totalDeposits = await Payment.aggregate([
            { $match: { status: 'completed' } },
            { $group: { _id: null, total: { $sum: '$amount' } } }
        ]);
        
        res.send({
            users,
            stats: {
                totalUsers,
                totalDeposits: totalDeposits[0]?.total || 0,
                activeToday: 0
            }
        });
    } catch (error) {
        res.status(500).send({ error: error.message });
    }
});

const PORT = process.env.PORT || 5000;
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});