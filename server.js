import dotenv from "dotenv";
dotenv.config();
import express from 'express';
import fileUpload from 'express-fileupload';
import jwt from 'jsonwebtoken';
import mysql from 'mysql2/promise';
import { open } from 'sqlite';
import ffmpeg from "fluent-ffmpeg";
import fetch from "node-fetch";
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import fs from 'fs';
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Ensure upload and transcoded directories exist
const uploadDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);

const transcodedDir = path.join(__dirname, 'transcoded');
if (!fs.existsSync(transcodedDir)) fs.mkdirSync(transcodedDir);

const app = express();
// Serve front-end files
app.use(express.static(path.join(__dirname, 'public')));

app.use(express.json());
app.use(fileUpload());

// JWT
const JWT_SECRET = 'mysecret';

// Hardcoded users
const users = [
    { username: 'admin', password: 'pass', role: 'admin' },
    { username: 'user1', password: 'pass', role: 'user' }
];

// auth middleware
function authMiddleware(req, res, next) {
    const token = req.headers["authorization"]?.split(" ")[1];
    if (!token) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

// mariadb setup
const {
    MYSQL_HOST = 'mariadb',
    MYSQL_PORT = 3306,
    MYSQL_DATABASE = 'video_app',
    MYSQL_USER = 'root',
    MYSQL_PASSWORD = 'example'
} = process.env;


// create pool and ensure DB exists
const pool = await mysql.createPool({
    host: MYSQL_HOST,
    port: Number(MYSQL_PORT),
    user: MYSQL_USER,
    password: MYSQL_PASSWORD,
    database: MYSQL_DATABASE,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// create table if missing
await pool.execute(`CREATE TABLE IF NOT EXISTS videos (
                                                          id VARCHAR(64) PRIMARY KEY,
    owner VARCHAR(255),
    originalName TEXT,
    inputPath TEXT,
    outputPath TEXT,
    status VARCHAR(64),
    format VARCHAR(32),
    createdAt DATETIME
    )`);

// helper wrappers to replace db.get/db.run/db.all
const dbGet = async (sql, params=[]) => {
    const [rows] = await pool.query(sql, params);
    return rows[0];
};
const dbAll = async (sql, params=[]) => {
    const [rows] = await pool.query(sql, params);
    return rows; // array
};
const dbRun = async (sql, params=[]) => {
    await pool.execute(sql, params);
};

// external api things
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY; // keep it safe in env

async function fetchRelatedYouTubeVideos(query) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(query)}&maxResults=3&key=${YOUTUBE_API_KEY}`;
    const resp = await fetch(url);
    if (!resp.ok) {
        console.error("YouTube API error:", await resp.text());
        return [];
    }
    const data = await resp.json();
    return data.items.map(item => ({
        title: item.snippet.title,
        thumbnail: item.snippet.thumbnails?.default?.url,
        link: `https://www.youtube.com/watch?v=${item.id.videoId}`
    }));
}

// api routes

// Login route
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username && u.password === password);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
});

// Upload route
app.post('/upload', authMiddleware, async (req, res) => {
    if (!req.files || !req.files.video) return res.status(400).json({ error: 'No file uploaded' });

    const video = req.files.video;
    const id = nanoid();
    const uploadDir = path.join(__dirname, 'uploads');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir);
    const uploadPath = path.join(uploadDir, `${id}_${video.name}`);

    await video.mv(uploadPath);

    const createdAt = new Date().toISOString();

    await dbGet(
        `INSERT INTO videos (id, owner, originalName, inputPath, status, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, req.user.username, video.name, uploadPath, 'uploaded', createdAt]
    );

    res.json({ message: 'File uploaded', id });
});

// transcode video
app.post("/transcode", authMiddleware, async (req, res) => {
    const { id, format } = req.body;

    const video = await dbGet(`SELECT * FROM videos WHERE id = ? AND owner = ?`, [id, req.user.username]);
    if (!video) return res.status(404).json({ error: "Video not found" });

    const inputPath = video.inputPath;
    const outputName = `${path.parse(video.originalName).name}.${format}`;
    const outputPath = path.join(transcodedDir, outputName);

    // Respond immediately
    res.json({ message: "Transcoding started" });

    console.log("Starting ffmpeg transcoding...", inputPath, "→", outputPath);

    ffmpeg(inputPath)
        .toFormat(format)
        .save(outputPath)
        .on("end", async () => {
            console.log("Transcoding finished:", outputPath);

            try {
                await dbRun(
                    `UPDATE videos SET status = ?, outputPath = ?, format = ? WHERE id = ?`,
                    ["transcoded", outputPath, format, id]
                );
                console.log("DB updated for video", id);
            } catch (err) {
                console.error("DB update failed:", err);
            }
        })
        .on("error", (err) => {
            console.error("ffmpeg error:", err.message);
        });
});

// List videos for user
app.get('/videos', authMiddleware, async (req, res) => {
    console.log("fetching videos.");
    const videos = await dbAll(`SELECT * FROM videos WHERE owner = ?`, [req.user.username]);
    res.json(videos);
});

// Get single video metadata
app.get('/videos/:id', authMiddleware, async (req, res) => {
    const video = await dbGet(
        `SELECT * FROM videos WHERE id = ? AND owner = ?`,
        [req.params.id, req.user.username]
    );
    if (!video) return res.status(404).json({ error: 'Video not found' });

    // Query YouTube using the video’s original name
    const related = await fetchRelatedYouTubeVideos(baseName);

    res.json({
        ...video,
        relatedVideos: related
    });
});

// Download video file
app.get('/download/:id', authMiddleware, async (req, res) => {
    const video = await dbGet(`SELECT * FROM videos WHERE id = ? AND owner = ?`, [req.params.id, req.user.username]);
    if (!video) return res.status(404).json({ error: 'Video not found' });

    const pathToSend = video.status === "transcoded" ? video.outputPath : video.inputPath;
    res.download(pathToSend, video.originalName);
});

app.get("/youtube", authMiddleware, async (req, res) => {
    const query = req.query.query;
    if (!query) return res.status(400).json({ error: "No query provided" });

    try {
        const apiKey = process.env.YOUTUBE_API_KEY;
        const response = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&key=${apiKey}&maxResults=5&type=video`);
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch from YouTube" });
    }
});

// start server
const PORT = 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));