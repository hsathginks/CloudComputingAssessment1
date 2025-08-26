import express from 'express';
import fileUpload from 'express-fileupload';
import jwt from 'jsonwebtoken';
import sqlite3 from 'sqlite3';
import { open } from 'sqlite';
import ffmpeg from "fluent-ffmpeg";
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import fs from 'fs';

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

// sqlite db setup
const db = await open({
    filename: "./db/video.db",
    driver: sqlite3.Database
});

await db.exec(`CREATE TABLE IF NOT EXISTS videos (
  id TEXT PRIMARY KEY,
  owner TEXT,
  originalName TEXT,
  inputPath TEXT,
  outputPath TEXT,
  status TEXT,
  format TEXT,
  createdAt TEXT
)`);

// // Create table if not exists
// await db.exec(`
//   CREATE TABLE IF NOT EXISTS videos (
//     id TEXT PRIMARY KEY,
//     owner TEXT,
//     originalName TEXT,
//     inputPath TEXT,
//     outputPath TEXT,
//     status TEXT,
//     format TEXT,
//     createdAt TEXT
//   )
// `);

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

    await db.run(
        `INSERT INTO videos (id, owner, originalName, inputPath, status, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
        [id, req.user.username, video.name, uploadPath, 'uploaded', createdAt]
    );

    res.json({ message: 'File uploaded', id });
});

// transcode video
app.post("/transcode", authMiddleware, (req, res) => {
    const { id, format } = req.body;

    db.get(`SELECT * FROM videos WHERE id = ? AND owner = ?`, [id, req.user.username], (err, video) => {
        if (err || !video) return res.status(404).send("Video not found");

        const inputPath = path.join("uploads", video.filename);
        const outputName = `${path.parse(video.filename).name}.${format}`;
        const outputPath = path.join("transcoded", outputName);

        ffmpeg(inputPath)
            .toFormat(format)
            .save(outputPath)
            .on("end", async () => {
                await db.run(
                    `UPDATE videos SET status = ?, outputPath = ?, format = ? WHERE id = ?`,
                    ["transcoded", outputPath, format, id]
                );
                res.json({ message: "Transcoding complete", file: outputName });
            })
            .on("error", err => res.status(500).send(err.message));

    });
})

// List videos for user
app.get('/videos', authMiddleware, async (req, res) => {
    const videos = await db.all(`SELECT * FROM videos WHERE owner = ?`, [req.user.username]);
    res.json(videos);
});

// Get single video metadata
app.get('/videos/:id', authMiddleware, async (req, res) => {
    const video = await db.get(`SELECT * FROM videos WHERE id = ? AND owner = ?`, [req.params.id, req.user.username]);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    res.json(video);
});

// Download video file
app.get('/download/:id', authMiddleware, async (req, res) => {
    const video = await db.get(`SELECT * FROM videos WHERE id = ? AND owner = ?`, [req.params.id, req.user.username]);
    if (!video) return res.status(404).json({ error: 'Video not found' });
    res.download(video.inputPath, video.originalName);
});

// start server
const PORT = 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));