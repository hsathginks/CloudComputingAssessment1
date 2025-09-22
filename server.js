import dotenv from "dotenv";
dotenv.config();
import express from 'express';
import fileUpload from 'express-fileupload';
import jwt from 'jsonwebtoken';
import mysql from 'mysql2/promise';
import ffmpeg from "fluent-ffmpeg";
import fetch from "node-fetch";
import path from 'path';
import { fileURLToPath } from 'url';
import { nanoid } from 'nanoid';
import fs from 'fs';
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// AWS S3 setup
const s3Client = new S3Client({
    region: process.env.AWS_REGION || 'ap-southeast-2'
});
const BUCKET_NAME = process.env.S3_BUCKET_NAME;

// Temporary directory for processing
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '200mb' }));
app.use(fileUpload());

const JWT_SECRET = process.env.JWT_SECRET || 'mysecret';

// Hardcoded users
const users = [
    { username: 'admin', password: 'pass', role: 'admin' },
    { username: 'user1', password: 'pass', role: 'user' }
];

function authMiddleware(req, res, next) {
    const token = req.headers["authorization"]?.split(" ")[1];
    if (!token) return res.sendStatus(401);
    jwt.verify(token, JWT_SECRET, (err, user) => {
        if (err) return res.sendStatus(403);
        req.user = user;
        next();
    });
}

// MariaDB setup
const {
    DB_HOST = process.env.DB_HOST, // Private IP of database EC2
    DB_PORT = 3306,
    DB_NAME = 'videodb',
    DB_USER = 'appuser',
    DB_PASSWORD = 'apppassword'
} = process.env;

let pool;

async function initDb() {
    let connected = false;
    while (!connected) {
        try {
            pool = await mysql.createPool({
                host: DB_HOST,
                port: Number(DB_PORT),
                user: DB_USER,
                password: DB_PASSWORD,
                database: DB_NAME,
                waitForConnections: true,
                connectionLimit: 10,
                queueLimit: 0,
            });

            await pool.query("SELECT 1");
            connected = true;
            console.log("Connected to MariaDB");

            // Update table to include S3 keys instead of file paths
            await pool.execute(`
                CREATE TABLE IF NOT EXISTS videos (
                    id VARCHAR(64) PRIMARY KEY,
                    owner VARCHAR(255),
                    originalName TEXT,
                    s3InputKey TEXT,
                    s3OutputKey TEXT,
                    status VARCHAR(64),
                    format VARCHAR(32),
                    createdAt DATETIME(3)
                )
            `);

        } catch (err) {
            console.log("Waiting for MariaDB...", err.message);
            await new Promise((r) => setTimeout(r, 2000));
        }
    }
}

// Helper functions
const dbGet = async (sql, params=[]) => {
    const [rows] = await pool.query(sql, params);
    return rows[0];
};
const dbAll = async (sql, params=[]) => {
    const [rows] = await pool.query(sql, params);
    return rows;
};
const dbRun = async (sql, params=[]) => {
    await pool.execute(sql, params);
};

// S3 helper functions
async function uploadToS3(buffer, key, contentType) {
    const command = new PutObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: contentType
    });
    await s3Client.send(command);
    console.log(`Uploaded to S3: ${key}`);
}

async function downloadFromS3(key, localPath) {
    const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key
    });
    const response = await s3Client.send(command);
    const stream = fs.createWriteStream(localPath);
    response.Body.pipe(stream);
    return new Promise((resolve, reject) => {
        stream.on('finish', resolve);
        stream.on('error', reject);
    });
}

async function getS3SignedUrl(key, expiresIn = 3600) {
    const command = new GetObjectCommand({
        Bucket: BUCKET_NAME,
        Key: key
    });
    return await getSignedUrl(s3Client, command, { expiresIn });
}

// Start server
initDb().then(() => {
    app.listen(3000, () => console.log("App listening on port 3000"));
});

// External API
const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY;

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

// Routes
app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const user = users.find(u => u.username === username && u.password === password);
    if (!user) return res.status(401).json({ error: 'Invalid credentials' });

    const token = jwt.sign({ username: user.username, role: user.role }, JWT_SECRET, { expiresIn: '1h' });
    res.json({ token });
});

// upload route
app.post('/upload', authMiddleware, async (req, res) => {
    if (!req.files || !req.files.video) return res.status(400).json({ error: 'No file uploaded' });

    try {
        const video = req.files.video;
        const id = nanoid();
        const s3Key = `uploads/${id}_${video.name}`;

        console.log(`Uploading ${video.name} to S3...`);
        await uploadToS3(video.data, s3Key, video.mimetype);

        const createdAt = new Date();

        await dbRun(
            `INSERT INTO videos (id, owner, originalName, s3InputKey, status, createdAt) VALUES (?, ?, ?, ?, ?, ?)`,
            [id, req.user.username, video.name, s3Key, 'uploaded', createdAt]
        );

        res.json({ message: 'File uploaded to S3', id });
    } catch (error) {
        console.error('Upload error:', error);
        res.status(500).json({ error: 'Upload failed' });
    }
});

// transcode route
app.post("/transcode", authMiddleware, async (req, res) => {
    const { id, format } = req.body;
    try {
        const video = await dbGet(`SELECT * FROM videos WHERE id = ? AND owner = ?`, [id, req.user.username]);
        if (!video) return res.status(404).json({ error: "Video not found" });

        await dbRun(`UPDATE videos SET status = ? WHERE id = ?`, ['processing', id]);
        res.json({ message: "Transcoding started" });

        // Download from S3 to temp location
        const tempInputPath = path.join(tempDir, `input_${id}`);
        console.log(`Downloading ${video.s3InputKey} from S3...`);
        await downloadFromS3(video.s3InputKey, tempInputPath);

        const outputName = `${path.parse(video.originalName).name}.${format}`;
        const tempOutputPath = path.join(tempDir, `output_${id}_${outputName}`);
        const s3OutputKey = `transcoded/${id}_${outputName}`;

        ffmpeg(tempInputPath)
            .videoCodec('libx264')
            .audioCodec('aac')
            .size('1280x720')
            .videoBitrate('1000k')
            .audioBitrate('128k')
            .outputOptions([
                '-preset medium',
                '-crf 23',
                '-maxrate 1500k',
                '-bufsize 3000k',
                '-threads 2'
            ])
            .toFormat(format)
            .on("end", async () => {
                try {
                    console.log(`Uploading ${outputName} to S3...`);
                    const transcodedBuffer = fs.readFileSync(tempOutputPath);
                    await uploadToS3(transcodedBuffer, s3OutputKey, `video/${format}`);

                    await dbRun(
                        `UPDATE videos SET status = ?, s3OutputKey = ?, format = ? WHERE id = ?`,
                        ["completed", s3OutputKey, format, id]
                    );

                    // Cleanup temp files
                    fs.unlinkSync(tempInputPath);
                    fs.unlinkSync(tempOutputPath);
                    console.log(`Transcoding completed: ${outputName}`);
                } catch (error) {
                    console.error("Post-processing error:", error);
                    await dbRun(`UPDATE videos SET status = ? WHERE id = ?`, ['error', id]);
                }
            })
            .on("error", async (err) => {
                console.error("Transcoding error:", err);
                await dbRun(`UPDATE videos SET status = ? WHERE id = ?`, ['error', id]);
                // Cleanup temp files
                if (fs.existsSync(tempInputPath)) fs.unlinkSync(tempInputPath);
                if (fs.existsSync(tempOutputPath)) fs.unlinkSync(tempOutputPath);
            })
            .save(tempOutputPath);

    } catch (error) {
        console.error("Error in /transcode:", error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

app.get('/videos/:id/status', authMiddleware, async (req, res) => {
    try {
        const video = await dbGet(
            `SELECT status FROM videos WHERE id = ? AND owner = ?`,
            [req.params.id, req.user.username]
        );
        if (!video) return res.status(404).json({ error: 'Video not found' });
        res.json({ status: video.status });
    } catch (error) {
        res.status(500).json({ error: 'Failed to fetch status' });
    }
});

app.get('/videos', authMiddleware, async (req, res) => {
    console.log("Fetching videos from database...");
    const videos = await dbAll(`SELECT * FROM videos WHERE owner = ?`, [req.user.username]);
    res.json(videos);
});

app.get('/videos/:id', authMiddleware, async (req, res) => {
    const video = await dbGet(
        `SELECT * FROM videos WHERE id = ? AND owner = ?`,
        [req.params.id, req.user.username]
    );
    if (!video) return res.status(404).json({ error: 'Video not found' });

    const baseName = path.parse(video.originalName).name;
    const related = await fetchRelatedYouTubeVideos(baseName);

    res.json({
        ...video,
        relatedVideos: related
    });
});

// download route
app.get('/download/:id', authMiddleware, async (req, res) => {
    try {
        const video = await dbGet(`SELECT * FROM videos WHERE id = ? AND owner = ?`, [req.params.id, req.user.username]);
        if (!video) return res.status(404).json({ error: 'Video not found' });

        const s3Key = video.status === "completed" ? video.s3OutputKey : video.s3InputKey;
        const signedUrl = await getS3SignedUrl(s3Key, 300); // 5 minutes

        res.json({ downloadUrl: signedUrl });
    } catch (error) {
        console.error('Download error:', error);
        res.status(500).json({ error: 'Download failed' });
    }
});

app.get("/youtube", authMiddleware, async (req, res) => {
    const query = req.query.query;
    if (!query) return res.status(400).json({ error: "No query provided" });

    try {
        const response = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&key=${YOUTUBE_API_KEY}&maxResults=5&type=video`);
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch from YouTube" });
    }
});