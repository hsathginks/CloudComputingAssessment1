import dotenv from "dotenv";
dotenv.config();
import { createHmac } from 'crypto';
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
import { DynamoDBClient, PutItemCommand, QueryCommand, ScanCommand } from "@aws-sdk/client-dynamodb";
import {
    CognitoIdentityProviderClient,
    SignUpCommand,
    ConfirmSignUpCommand,
    InitiateAuthCommand,
    RespondToAuthChallengeCommand,
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
const dynamoClient = new DynamoDBClient({ region: process.env.AWS_REGION || 'ap-southeast-2' });

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
            ],
            WithDecryption: true // This is needed for SecureString parameters
        });

        const response = await ssmClient.send(command);
        const params = {};

        response.Parameters.forEach(param => {
            const key = param.Name.split('/').pop();
            params[key] = param.Value.trim(); // Add .trim() to remove whitespace/newlines
        });

        console.log('Retrieved parameters:', Object.keys(params));
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

    console.log('Configuration loaded:');
    console.log('- COGNITO_CLIENT_ID:', CONFIG.COGNITO_CLIENT_ID);
    console.log('- COGNITO_CLIENT_SECRET exists:', !!CONFIG.COGNITO_CLIENT_SECRET);
    console.log('- COGNITO_CLIENT_SECRET starts with:', CONFIG.COGNITO_CLIENT_SECRET ? CONFIG.COGNITO_CLIENT_SECRET.substring(0, 10) + '...' : 'undefined');
    console.log('Configuration loaded successfully');
    return CONFIG;
}

// Function to calculate SECRET_HASH for Cognito
function calculateSecretHash(username, clientId, clientSecret) {
    console.log('Calculating SECRET_HASH with:');
    console.log('- Username:', username);
    console.log('- Client ID:', clientId);
    console.log('- Client Secret exists:', !!clientSecret);
    console.log('- Client Secret length:', clientSecret ? clientSecret.length : 0);

    return createHmac('SHA256', clientSecret)
        .update(username + clientId)
        .digest('base64');
}

// DynamoDB Analytics Functions
async function logVideoAnalytics(videoId, action, userId, additionalData = {}) {
    try {
        const timestamp = Date.now();
        const command = new PutItemCommand({
            TableName: 'video-analytics',
            Item: {
                video_id: { S: videoId },
                timestamp: { N: timestamp.toString() },
                action: { S: action },
                user_id: { S: userId },
                date: { S: new Date().toISOString().split('T')[0] }, // YYYY-MM-DD format
                ...Object.keys(additionalData).reduce((acc, key) => {
                    acc[key] = { S: additionalData[key].toString() };
                    return acc;
                }, {})
            }
        });

        await dynamoClient.send(command);
        console.log(`Analytics logged: ${action} for video ${videoId} by ${userId}`);
    } catch (error) {
        console.error('Error logging analytics:', error);
        // Don't fail the main operation if analytics logging fails
    }
}

async function getVideoAnalytics(videoId) {
    try {
        const command = new QueryCommand({
            TableName: 'video-analytics',
            KeyConditionExpression: 'video_id = :vid',
            ExpressionAttributeValues: {
                ':vid': { S: videoId }
            },
            ScanIndexForward: false // Most recent first
        });

        const response = await dynamoClient.send(command);
        return response.Items?.map(item => ({
            timestamp: parseInt(item.timestamp.N),
            action: item.action.S,
            userId: item.user_id.S,
            date: item.date.S
        })) || [];
    } catch (error) {
        console.error('Error getting analytics:', error);
        return [];
    }
}

async function getUserAnalytics(userId) {
    try {
        const command = new ScanCommand({
            TableName: 'video-analytics',
            FilterExpression: 'user_id = :uid',
            ExpressionAttributeValues: {
                ':uid': { S: userId }
            }
        });

        const response = await dynamoClient.send(command);
        return response.Items?.map(item => ({
            videoId: item.video_id.S,
            timestamp: parseInt(item.timestamp.N),
            action: item.action.S,
            date: item.date.S
        })) || [];
    } catch (error) {
        console.error('Error getting user analytics:', error);
        return [];
    }
}

// Temporary directory for processing
const tempDir = path.join(__dirname, 'temp');
if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

const app = express();
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '200mb' }));
app.use(fileUpload());

// Auth middleware for Cognito JWTs
async function authMiddleware(req, res, next) {
    const token = req.headers["authorization"]?.split(" ")[1];
    if (!token) return res.sendStatus(401);

    try {
        const decoded = jwt.decode(token);

        if (!decoded || decoded.exp < Date.now() / 1000) {
            return res.sendStatus(403);
        }

        // Get user's groups from Cognito
        const groups = await getUserGroups(decoded['cognito:username']);

        req.user = {
            username: decoded['cognito:username'],
            email: decoded.email,
            groups: groups,
            role: groups.includes('admin') ? 'admin' : 'user'
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

// Admin-only middleware
function adminOnly(req, res, next) {
    if (!req.user || !req.user.groups.includes('admin')) {
        return res.status(403).json({ error: 'Admin access required' });
    }
    next();
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
        console.log("ChallengeName:", response.ChallengeName);
        // If MFA challenge required
        if (response.ChallengeName === 'EMAIL_OTP') {
            res.json({
                mfaRequired: true,
                session: response.Session,
                username: username,
                message: 'Check your email for verification code'
            });
        }
        else if (response.AuthenticationResult) {
            // if normal mfa isn't triggered (unlikely)
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

// MFA verification endpoint
app.post('/verify-mfa', async (req, res) => {
    const { username, session, code } = req.body;

    try {
        const secretHash = calculateSecretHash(username, CONFIG.COGNITO_CLIENT_ID, CONFIG.COGNITO_CLIENT_SECRET);

        const command = new RespondToAuthChallengeCommand({
            ChallengeName: 'EMAIL_OTP',
            ClientId: CONFIG.COGNITO_CLIENT_ID,
            ChallengeResponses: {
                USERNAME: username,
                EMAIL_OTP_CODE: code,
                SECRET_HASH: secretHash
            },
            Session: session
        });

        const response = await cognitoClient.send(command);

        if (response.AuthenticationResult) {
            const decoded = jwt.decode(response.AuthenticationResult.IdToken);
            const groups = await getUserGroups(username);
            const role = groups.includes('admin') ? 'admin' : 'user';

            res.json({
                token: response.AuthenticationResult.IdToken,
                username: decoded['cognito:username'],
                email: decoded.email,
                role: role
            });
        } else {
            res.status(400).json({ error: 'Invalid verification code' });
        }
    } catch (error) {
        console.error("MFA verification error:", error);
        res.status(400).json({ error: error.message || 'Verification failed' });
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
        console.log('Confirming user:', username);
        console.log('CONFIG loaded:', !!CONFIG.COGNITO_CLIENT_ID, !!CONFIG.COGNITO_CLIENT_SECRET);

        if (!CONFIG.COGNITO_CLIENT_SECRET) {
            console.error('CLIENT_SECRET not available in CONFIG');
            return res.status(500).json({ error: 'Server configuration error' });
        }

        const secretHash = calculateSecretHash(username, CONFIG.COGNITO_CLIENT_ID, CONFIG.COGNITO_CLIENT_SECRET);

        const command = new ConfirmSignUpCommand({
            ClientId: CONFIG.COGNITO_CLIENT_ID,
            Username: username,
            ConfirmationCode: confirmationCode,
            SecretHash: secretHash,
        });

        await cognitoClient.send(command);
        res.json({ message: 'Email confirmed successfully' });
    } catch (error) {
        console.error('Confirmation error:', error);
        console.error('Full error details:', JSON.stringify(error, null, 2));
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

        // Log analytics
        await logVideoAnalytics(id, 'upload', req.user.username, {
            filename: video.name,
            filesize: video.size
        });

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

                    // Log transcoding completion
                    await logVideoAnalytics(id, 'transcode_completed', 'system', { format: format });

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

        // Log download analytics
        await logVideoAnalytics(req.params.id, 'download', req.user.username);

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

// Admin-only routes
app.get('/admin/all-videos', authMiddleware, adminOnly, async (req, res) => {
    try {
        console.log(`Admin ${req.user.username} viewing all videos`);
        const videos = await dbAll(`
            SELECT id, owner, originalName, status, format, createdAt
            FROM videos
            ORDER BY createdAt DESC
        `);
        res.json(videos);
    } catch (error) {
        console.error('Error fetching all videos:', error);
        res.status(500).json({ error: 'Failed to fetch videos' });
    }
});

// app.get('/admin/users/:username/videos', authMiddleware, adminOnly, async (req, res) => {
//     try {
//         const { username } = req.params;
//         console.log(`Admin ${req.user.username} viewing videos for user ${username}`);
//         const videos = await dbAll(`SELECT * FROM videos WHERE owner = ?`, [username]);
//         res.json(videos);
//     } catch (error) {
//         console.error('Error fetching user videos:', error);
//         res.status(500).json({ error: 'Failed to fetch user videos' });
//     }
// });

// app.delete('/admin/videos/:id', authMiddleware, adminOnly, async (req, res) => {
//     try {
//         const { id } = req.params;
//         console.log(`Admin ${req.user.username} deleting video ${id}`);
//
//         // Get video info first
//         const video = await dbGet(`SELECT * FROM videos WHERE id = ?`, [id]);
//         if (!video) return res.status(404).json({ error: 'Video not found' });
//
//         // Delete from database
//         await dbRun(`DELETE FROM videos WHERE id = ?`, [id]);
//
//         res.json({ message: 'Video deleted successfully' });
//     } catch (error) {
//         console.error('Error deleting video:', error);
//         res.status(500).json({ error: 'Failed to delete video' });
//     }
// });

app.get('/admin/stats', authMiddleware, adminOnly, async (req, res) => {
    try {
        const stats = await dbAll(`
            SELECT 
                COUNT(*) as total_videos,
                COUNT(CASE WHEN status = 'uploaded' THEN 1 END) as uploaded,
                COUNT(CASE WHEN status = 'processing' THEN 1 END) as processing,
                COUNT(CASE WHEN status = 'completed' THEN 1 END) as completed,
                COUNT(CASE WHEN status = 'error' THEN 1 END) as error,
                COUNT(DISTINCT owner) as unique_users
            FROM videos
        `);
        res.json(stats[0]);
    } catch (error) {
        console.error('Error fetching stats:', error);
        res.status(500).json({ error: 'Failed to fetch stats' });
    }
});

// Analytics routes
app.get('/videos/:id/analytics', authMiddleware, async (req, res) => {
    try {
        const video = await dbGet(`SELECT * FROM videos WHERE id = ? AND owner = ?`,
            [req.params.id, req.user.username]);

        if (!video && req.user.role !== 'admin') {
            return res.status(404).json({ error: 'Video not found' });
        }

        const analytics = await getVideoAnalytics(req.params.id);
        res.json(analytics);
    } catch (error) {
        console.error('Error fetching video analytics:', error);
        res.status(500).json({ error: 'Failed to fetch analytics' });
    }
});

app.get('/user/analytics', authMiddleware, async (req, res) => {
    try {
        const analytics = await getUserAnalytics(req.user.username);
        res.json(analytics);
    } catch (error) {
        console.error('Error fetching user analytics:', error);
        res.status(500).json({ error: 'Failed to fetch user analytics' });
    }
});

app.get('/admin/analytics/summary', authMiddleware, adminOnly, async (req, res) => {
    try {
        const command = new ScanCommand({
            TableName: 'video-analytics'
        });

        const response = await dynamoClient.send(command);
        const items = response.Items || [];

        // Process analytics data
        const summary = {
            totalEvents: items.length,
            uploads: items.filter(item => item.action.S === 'upload').length,
            downloads: items.filter(item => item.action.S === 'download').length,
            transcodes: items.filter(item => item.action.S === 'transcode_completed').length,
            uniqueUsers: [...new Set(items.map(item => item.user_id.S))].length,
            recentActivity: items
                .sort((a, b) => parseInt(b.timestamp.N) - parseInt(a.timestamp.N))
                .slice(0, 10)
                .map(item => ({
                    action: item.action.S,
                    userId: item.user_id.S,
                    timestamp: parseInt(item.timestamp.N),
                    date: new Date(parseInt(item.timestamp.N)).toLocaleString()
                }))
        };

        res.json(summary);
    } catch (error) {
        console.error('Error fetching analytics summary:', error);
        res.status(500).json({ error: 'Failed to fetch analytics summary' });
    }
});

// Initialize app
async function initApp() {
    await loadConfiguration();
    await initDb();
    app.listen(3000, () => console.log("App listening on port 3000"));
}

initApp();