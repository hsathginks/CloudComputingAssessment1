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
import { SSMClient, GetParametersCommand } from "@aws-sdk/client-ssm";
import { SecretsManagerClient, GetSecretValueCommand } from "@aws-sdk/client-secrets-manager";
import {
    CognitoIdentityProviderClient,
    SignUpCommand,
    ConfirmSignUpCommand,
    InitiateAuthCommand,
    AdminListGroupsForUserCommand
} from "@aws-sdk/client-cognito-identity-provider";

ffmpeg.setFfmpegPath(ffmpegInstaller.path);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// AWS clients
const ssmClient = new SSMClient({ region: process.env.AWS_REGION || 'ap-southeast-2' });
const secretsClient = new SecretsManagerClient({ region: process.env.AWS_REGION || 'ap-southeast-2' });
const cognitoClient = new CognitoIdentityProviderClient({ region: process.env.AWS_REGION || 'ap-southeast-2' });
const s3Client = new S3Client({ region: process.env.AWS_REGION || 'ap-southeast-2' });

// Global configuration object
let CONFIG = {};

// Function to get parameters from Parameter Store
async function getParameters() {
    try {
        const command = new GetParametersCommand({
            Names: [
                '/myapp/database-host',
                '/myapp/s3-bucket',
                '/myapp/youtube-api-key',
                '/myapp/cognito-user-pool-id',
                '/myapp/cognito-client-id',
                '/myapp/cognito-client-secret'
            ]
        });

        const response = await ssmClient.send(command);
        const params = {};

        response.Parameters.forEach(param => {
            const key = param.Name.split('/').pop();
            params[key] = param.Value;
        });

        return params;
    } catch (error) {
        console.error('Error getting parameters:', error);
        return {};
    }
}

// Function to get secret from Secrets Manager
async function getSecret(secretName) {
    try {
        const command = new GetSecretValueCommand({
            SecretId: secretName
        });

        const response = await secretsClient.send(command);
        return JSON.parse(response.SecretString);
    } catch (error) {
        console.error(`Error getting secret ${secretName}:`, error);
        return null;
    }
}

// Load all configuration
async function loadConfiguration() {
    const params = await getParameters();
    const dbCredentials = await getSecret('n11302836/database-credentials');
    const jwtSecret = await getSecret('n11302836/jwt-secret');

    CONFIG = {
        DB_HOST: params['database-host'] || process.env.DB_HOST,
        DB_PASSWORD: dbCredentials?.password || process.env.DB_PASSWORD || 'apppassword',
        S3_BUCKET_NAME: params['s3-bucket'] || process.env.S3_BUCKET_NAME,
        YOUTUBE_API_KEY: params['youtube-api-key'] || process.env.YOUTUBE_API_KEY,
        JWT_SECRET: jwtSecret?.['jwt-secret'] || process.env.JWT_SECRET || 'mysecret',
        COGNITO_USER_POOL_ID: params['cognito-user-pool-id'] || process.env.COGNITO_USER_POOL_ID,
        COGNITO_CLIENT_ID: params['cognito-client-id'] || process.env.COGNITO_CLIENT_ID,
        COGNITO_CLIENT_SECRET: params['cognito-client-secret'] || process.env.COGNITO_CLIENT_SECRET
    };

    console.log('Configuration loaded successfully');
    return CONFIG;
}

// secret hash
function calculateSecretHash(username, clientId, clientSecret) {
    return crypto
        .createHmac('SHA256', clientSecret)
        .update(username + clientId)
        .digest('base64');
}

// Temporary directory for processing
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '200mb' }));
app.use(fileUpload());

// Auth middleware for Cognito JWTs
function authMiddleware(req, res, next) {
    const token = req.headers["authorization"]?.split(" ")[1];
    if (!token) return res.sendStatus(401);

    try {
        const decoded = jwt.decode(token);

        if (!decoded || decoded.exp < Date.now() / 1000) {
            return res.sendStatus(403);
        }

        req.user = {
            username: decoded['cognito:username'],
            email: decoded.email,
        };
        next();
    } catch (err) {
        return res.sendStatus(403);
    }
}

// Database setup
let pool;

async function initDb() {
    let connected = false;
    while (!connected) {
        try {
            pool = await mysql.createPool({
                host: CONFIG.DB_HOST,
                port: 3306,
                user: 'appuser',
                password: CONFIG.DB_PASSWORD,
                database: 'videodb',
                waitForConnections: true,
                connectionLimit: 10,
                queueLimit: 0,
            });

            await pool.query("SELECT 1");
            connected = true;
            console.log("Connected to MariaDB");

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
        Bucket: CONFIG.S3_BUCKET_NAME,
        Key: key,
        Body: buffer,
        ContentType: contentType
    });
    await s3Client.send(command);
    console.log(`Uploaded to S3: ${key}`);
}

async function downloadFromS3(key, localPath) {
    const command = new GetObjectCommand({
        Bucket: CONFIG.S3_BUCKET_NAME,
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
        Bucket: CONFIG.S3_BUCKET_NAME,
        Key: key
    });
    return await getSignedUrl(s3Client, command, { expiresIn });
}

// Helper function to get user's groups
async function getUserGroups(username) {
    try {
        const command = new AdminListGroupsForUserCommand({
            UserPoolId: CONFIG.COGNITO_USER_POOL_ID,
            Username: username,
        });

        const response = await cognitoClient.send(command);
        return response.Groups.map(group => group.GroupName);
    } catch (error) {
        console.error('Error getting user groups:', error);
        return [];
    }
}

// YouTube API function
async function fetchRelatedYouTubeVideos(query) {
    const url = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&q=${encodeURIComponent(query)}&maxResults=3&key=${CONFIG.YOUTUBE_API_KEY}`;
    try {
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
    } catch (error) {
        console.error("YouTube API error:", error);
        return [];
    }
}

// Routes
app.post('/login', async (req, res) => {
    const { username, password } = req.body;

    try {
        const secretHash = calculateSecretHash(username, CONFIG.COGNITO_CLIENT_ID, CONFIG.COGNITO_CLIENT_SECRET);
        const command = new InitiateAuthCommand({
            AuthFlow: 'USER_PASSWORD_AUTH',
            ClientId: CONFIG.COGNITO_CLIENT_ID,
            AuthParameters: {
                USERNAME: username,
                PASSWORD: password,
                SECRET_HASH: secretHash,
            },
        });

        const response = await cognitoClient.send(command);

        if (response.AuthenticationResult) {
            const idToken = response.AuthenticationResult.IdToken;
            const decoded = jwt.decode(idToken);
            const groups = await getUserGroups(username);
            const role = groups.includes('admin') ? 'admin' : 'user';

            res.json({
                token: idToken,
                username: decoded['cognito:username'],
                email: decoded.email,
                role: role
            });
        } else {
            res.status(401).json({ error: 'Authentication failed' });
        }
    } catch (error) {
        console.error('Cognito login error:', error);
        res.status(401).json({ error: 'Invalid credentials' });
    }
});

app.post('/register', async (req, res) => {
    const { username, password, email } = req.body;

    try {
        const secretHash = calculateSecretHash(username, CONFIG.COGNITO_CLIENT_ID, CONFIG.COGNITO_CLIENT_SECRET);
        const command = new SignUpCommand({
            ClientId: CONFIG.COGNITO_CLIENT_ID,
            Username: username,
            Password: password,
            SecretHash: secretHash,
            UserAttributes: [
                {
                    Name: 'email',
                    Value: email,
                },
            ],
        });

        await cognitoClient.send(command);
        res.json({ message: 'User registered. Please check email for confirmation code.' });
    } catch (error) {
        console.error('Registration error:', error);
        res.status(400).json({ error: 'Registration failed: ' + error.message });
    }
});

app.post('/confirm', async (req, res) => {
    const { username, confirmationCode } = req.body;

    try {
        const secretHash = calculateSecretHash(username, CONFIG.COGNITO_CLIENT_ID, CONFIG.COGNITO_CLIENT_SECRET);
        const command = new ConfirmSignUpCommand({
            ClientId: CONFIG.COGNITO_CLIENT_ID,
            Username: username,
            ConfirmationCode: confirmationCode,
            secretHash: secretHash,
        });

        await cognitoClient.send(command);
        res.json({ message: 'Email confirmed successfully' });
    } catch (error) {
        console.error('Confirmation error:', error);
        res.status(400).json({ error: 'Confirmation failed: ' + error.message });
    }
});

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

app.post("/transcode", authMiddleware, async (req, res) => {
    const { id, format } = req.body;
    try {
        const video = await dbGet(`SELECT * FROM videos WHERE id = ? AND owner = ?`, [id, req.user.username]);
        if (!video) return res.status(404).json({ error: "Video not found" });

        await dbRun(`UPDATE videos SET status = ? WHERE id = ?`, ['processing', id]);
        res.json({ message: "Transcoding started" });

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

app.get('/download/:id', authMiddleware, async (req, res) => {
    try {
        const video = await dbGet(`SELECT * FROM videos WHERE id = ? AND owner = ?`, [req.params.id, req.user.username]);
        if (!video) return res.status(404).json({ error: 'Video not found' });

        const s3Key = video.status === "completed" ? video.s3OutputKey : video.s3InputKey;
        const signedUrl = await getS3SignedUrl(s3Key, 300);

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
        const response = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(query)}&key=${CONFIG.YOUTUBE_API_KEY}&maxResults=5&type=video`);
        const data = await response.json();
        res.json(data);
    } catch (err) {
        console.error(err);
        res.status(500).json({ error: "Failed to fetch from YouTube" });
    }
});

// Initialize app
async function initApp() {
    await loadConfiguration();
    await initDb();
    app.listen(3000, () => console.log("App listening on port 3000"));
}

initApp();