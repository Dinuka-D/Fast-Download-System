const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const dotenv = require('dotenv'); 

// --- 1. FIREBASE IMPORTS ---
const { initializeApp } = require('firebase/app');
const { getFirestore, doc, setDoc, getDoc, updateDoc, collection, query, where, getDocs } = require('firebase/firestore');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const SESSION_SECRET = process.env.SESSION_SECRET || 'torrent-drive-secret-2024';

// Global variable for the WebTorrent client instance
let client;

// Define the temporary downloads directory
const DOWNLOAD_PATH = path.join(__dirname, 'downloads');
if (!fs.existsSync(DOWNLOAD_PATH)) {
    fs.mkdirSync(DOWNLOAD_PATH, { recursive: true });
}

// === GOOGLE CONFIG (Reading from .env) ===
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

console.log('🔧 Google OAuth Config:');
console.log('Client ID:', GOOGLE_CLIENT_ID ? '✅ Set from .env' : '❌ Missing');
console.log('Redirect URI:', REDIRECT_URI);

const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);

// --- 2. FIREBASE INITIALIZATION ---
const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY || 'PLACEHOLDER_API_KEY',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'localhost',
    projectId: process.env.FIREBASE_PROJECT_ID || 'torrent-drive-project',
};

// Initialize Firebase App
const firebaseApp = initializeApp(firebaseConfig);
const db = getFirestore(firebaseApp);
// --- END FIREBASE INITIALIZATION ---


// === MIDDLEWARE ===
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(session({
    secret: SESSION_SECRET, 
    resave: false,
    saveUninitialized: true,
    cookie: { secure: false } 
}));

// Middleware to check if user is authenticated
function isAuthenticated(req, res, next) {
    if (req.session.user) {
        return next();
    }
    if (req.originalUrl.startsWith('/api')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    res.redirect('/');
}

// Helper function to format bytes into human-readable speed
function humanSpeed(bytesPerSecond) {
    if (bytesPerSecond === 0) return '0.00 B/s';
    const i = Math.floor(Math.log(bytesPerSecond) / Math.log(1024));
    const sizes = ['B/s', 'KB/s', 'MB/s', 'GB/s', 'TB/s'];
    return `${(bytesPerSecond / Math.pow(1024, i)).toFixed(2)} ${sizes[i]}`;
}

// === API ROUTES ===
// (Routes remain the same, they use the global 'client' variable)

// Get current user info
app.get('/api/user', (req, res) => {
    if (req.session.user) {
        const { id, name, email, picture } = req.session.user;
        return res.json({ user: { id, name, email, picture } });
    }
    res.json({ user: null });
});

// 1. Google Login
app.get('/auth/google', (req, res) => {
    const scopes = [
        'https://www.googleapis.com/auth/userinfo.email',
        'https://www.googleapis.com/auth/userinfo.profile',
        'https://www.googleapis.com/auth/drive.file'
    ];

    const url = oauth2Client.generateAuthUrl({
        access_type: 'offline',
        scope: scopes,
        prompt: 'consent' 
    });
    res.redirect(url);
});

// 2. Google OAuth Callback
app.get('/auth/callback', async (req, res) => {
    if (!req.query.code) {
        console.error('Authentication failed: Missing authorization code in callback.');
        return res.redirect(`/?error=no_auth_code&message=${encodeURIComponent('Authentication failed: Missing authorization code.')}`);
    }

    try {
        const { tokens } = await oauth2Client.getToken(req.query.code);
        oauth2Client.setCredentials(tokens);

        const oauth2 = google.oauth2({ version: 'v2', auth: oauth2Client });
        const userInfo = await oauth2.userinfo.get();

        req.session.user = {
            id: userInfo.data.id,
            name: userInfo.data.name,
            email: userInfo.data.email,
            picture: userInfo.data.picture,
            tokens: tokens
        };

        res.redirect('/');
    } catch (error) {
        console.error('Authentication failed during token exchange:', error.message);
        const errorMessage = error.message.includes('redirect_uri_mismatch') 
            ? 'redirect_uri_mismatch' 
            : 'Authentication Error: Please check server logs.';
        res.redirect(`/?error=${errorMessage}&message=${encodeURIComponent(error.message)}`);
    }
});

// 3. Logout
app.get('/auth/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/');
    });
});


// Add Torrent Link
app.post('/api/add-link', isAuthenticated, (req, res) => {
    const { link } = req.body;

    if (!link || !link.startsWith('magnet:')) {
        return res.status(400).json({ success: false, error: 'Invalid magnet link provided.' });
    }

    startTorrent(link, req.session.user)
        .then(() => res.json({ success: true, message: 'Torrent added. Starting connection...' }))
        .catch(error => res.status(500).json({ success: false, error: error.message }));
});

// File Upload Setup
const upload = multer({ dest: 'uploads/' });

// Upload .torrent file
app.post('/api/upload-file', isAuthenticated, upload.single('torrent'), async (req, res) => {
    if (!req.file) {
        return res.status(400).json({ success: false, error: 'No file uploaded.' });
    }

    try {
        const filePath = path.join(__dirname, req.file.path);
        
        await startTorrent(filePath, req.session.user);
        
        // Clean up the uploaded .torrent file
        fs.unlinkSync(filePath);

        res.json({ success: true, message: 'Torrent file added. Starting connection...' });
    } catch (error) {
        console.error('Torrent file upload error:', error);
        res.status(500).json({ success: false, error: 'Failed to process torrent file.' });
    }
});

// Cancel Download
app.delete('/api/cancel-download/:infoHash', isAuthenticated, async (req, res) => {
    const { infoHash } = req.params;
    const userId = req.session.user.id;
    
    // Check if client is initialized
    if (!client) {
        return res.status(503).json({ success: false, error: 'Server is still initializing. Please try again.' });
    }
    
    const torrent = client.get(infoHash);
    
    // Check Firestore for the download job
    const jobRef = doc(db, `artifacts/${process.env.__app_id}/users/${userId}/downloads`, infoHash);
    const jobSnap = await getDoc(jobRef);
    
    if (!jobSnap.exists()) {
        return res.status(404).json({ success: false, error: 'Download job not found or unauthorized.' });
    }
    
    if (torrent) {
        torrent.destroy(() => {
            console.log(`🗑️ Torrent destroyed: ${torrent.name}`);
        });
    }

    try {
        const jobData = jobSnap.data();
        const tempDownloadPath = path.join(DOWNLOAD_PATH, jobData.name);
        
        if (fs.existsSync(tempDownloadPath)) {
            fs.rmSync(tempDownloadPath, { recursive: true, force: true });
            console.log(`🗑️ Local download folder removed: ${tempDownloadPath}`);
        }
        
        // Delete the Firestore document
        await updateDoc(jobRef, {
            status: 'cancelled',
            error: 'Transfer cancelled by user.',
            downloadSpeed: 0,
            uploadSpeed: 0,
            progress: 0
        });
        
    } catch (cleanupError) {
        console.warn(`Could not clean up local files or Firestore for ${infoHash}:`, cleanupError.message);
    }
    
    res.json({ success: true, message: 'Transfer cancelled.' });
});


// === TORRENTING LOGIC (STREAMING OPTIMIZATION) ===

/**
 * Starts a torrent download, prioritizes the largest file, and initiates streaming upload.
 */
function startTorrent(identifier, user) {
    return new Promise((resolve, reject) => {
        
        if (!client) {
            return reject(new Error('WebTorrent client is not initialized. Server starting up.'));
        }
        
        // Check if the torrent is already active or being added
        if (client.get(identifier)) {
            console.warn(`Attempted to add duplicate torrent: ${identifier}`);
            return reject(new Error('This torrent is already active or in progress.'));
        }

        client.add(identifier, { path: DOWNLOAD_PATH }, (torrent) => {
            
            const initialDownload = {
                userId: user.id,
                infoHash: torrent.infoHash,
                name: torrent.name,
                status: 'connecting',
                progress: 0,
                downloadSpeed: 0,
                uploadSpeed: 0,
                peers: 0,
                driveLink: null,
                fileName: null, 
                error: null,
                fileSize: 0,
            };
            
            // --- FIREBASE: Write initial job state ---
            const jobRef = doc(db, `artifacts/${process.env.__app_id}/users/${user.id}/downloads`, torrent.infoHash);
            setDoc(jobRef, initialDownload).catch(e => console.error("Firestore initial write failed:", e));

            console.log(`🟢 Starting new torrent: ${torrent.name}`);

            torrent.on('ready', () => {
                // --- FAST FILE OPTIMIZATION ---
                const largestFile = torrent.files.reduce((a, b) => a.length > b.length ? a : b);
                
                torrent.files.forEach(file => {
                    if (file !== largestFile) {
                        file.deselect();
                    }
                });
                
                const updateReady = {
                    fileName: largestFile.name,
                    status: 'downloading',
                    fileSize: largestFile.length,
                };
                updateDoc(jobRef, updateReady).catch(e => console.error("Firestore ready update failed:", e));
                
                console.log(`📢 Torrent ready. Prioritizing: ${largestFile.name}. Starting Drive upload stream...`);

                // Start the non-blocking upload stream immediately
                uploadToDrive(jobRef, user, largestFile)
                    .then(() => {
                        console.log(`✅ Drive Upload Stream FINISHED: ${largestFile.name}`);
                        // Final update to Firestore
                        updateDoc(jobRef, {
                            status: 'completed',
                            progress: 100,
                            uploadSpeed: 0,
                        }).catch(e => console.error("Firestore completion update failed:", e));

                        // Clean up local files after successful upload stream completion
                        const torrentFolder = path.join(DOWNLOAD_PATH, torrent.name);
                        if (fs.existsSync(torrentFolder)) {
                            fs.rmSync(torrentFolder, { recursive: true, force: true });
                            console.log(`🗑️ Cleaned up local files for: ${torrent.name}`);
                        }
                    })
                    .catch(error => {
                        updateDoc(jobRef, {
                            status: 'failed',
                            error: `Drive Upload Failed: ${error.message}`,
                        }).catch(e => console.error("Firestore failure update failed:", e));
                        console.error(`❌ Drive Upload Stream Failed: ${largestFile.name}`, error);
                    });
                // --- END OPTIMIZATION ---
            });
            
            torrent.on('download', () => {
                // Throttle Firestore updates to prevent excessive writes
                if (Date.now() % 500 < 50) { // Update every 500ms
                    const updateDownload = {
                        progress: Math.round(torrent.progress * 100),
                        downloadSpeed: torrent.downloadSpeed,
                        peers: torrent.numPeers,
                        status: 'downloading'
                    };
                    updateDoc(jobRef, updateDownload).catch(e => console.error("Firestore download update failed:", e));
                }
            });

            torrent.on('done', () => {
                // Local download 100% complete. 
                console.log(`⭐ Local download 100% complete. Waiting for Drive stream to close...`);
            });

            torrent.on('error', (err) => {
                updateDoc(jobRef, {
                    status: 'failed',
                    error: err.message,
                }).catch(e => console.error("Firestore torrent error update failed:", e));
                console.error(`❌ Torrent error for ${torrent.name}:`, err);
            });
            
            resolve();
        }, (err) => {
            reject(err);
        });
    });
}

// === UPLOAD TO GOOGLE DRIVE (Resumable Upload with Progress Tracking) ===
async function uploadToDrive(jobRef, user, file) {
    const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
    
    // Function to attempt the upload
    const attemptUpload = async (tokens) => {
        auth.setCredentials(tokens);
        const drive = google.drive({ version: 'v3', auth });
        
        const fileStream = file.createReadStream();

        const fileMetadata = {
            name: file.name,
        };

        let lastUpdateTime = Date.now();
        let totalUploadedBytes = 0;

        const response = await drive.files.create({
            resource: fileMetadata,
            media: {
                mimeType: file.mime || 'application/octet-stream', 
                body: fileStream 
            },
            resumable: true, 
            fields: 'id, webContentLink, webViewLink, name'
        }, {
            onUploadProgress: (event) => {
                if (event.bytesRead > totalUploadedBytes) { // Check if new bytes were read
                    const currentTime = Date.now();
                    const bytesRead = event.bytesRead;
                    const timeElapsedSeconds = (currentTime - lastUpdateTime) / 1000;
                    const bytesSinceLastUpdate = bytesRead - totalUploadedBytes;

                    // Calculate speed (Bytes per second)
                    const speed = bytesSinceLastUpdate / timeElapsedSeconds;

                    // Throttle Firestore updates for upload progress
                    if (currentTime % 500 < 50) {
                        const fileSize = file.length;
                        const uploadProgress = Math.min(99, Math.round((bytesRead / fileSize) * 100));

                        updateDoc(jobRef, {
                            uploadedBytes: bytesRead,
                            uploadSpeed: speed,
                            progress: uploadProgress,
                            status: 'uploading'
                        }).catch(e => console.error("Firestore upload update failed:", e));
                    }
                    
                    // Update tracking variables for the next measurement
                    lastUpdateTime = currentTime;
                    totalUploadedBytes = bytesRead;
                }
            }
        });

        // Final Firestore update with Drive link
        await updateDoc(jobRef, {
            driveLink: response.data.webContentLink || response.data.webViewLink,
            fileName: response.data.name,
        });
        
        return response.data; 
    };

    try {
        await attemptUpload(user.tokens);
        
    } catch (error) {
        // Token refresh logic 
        if (user.tokens.refresh_token && (error.message.includes('401') || error.message.includes('invalid_grant') || error.message.includes('Token has been expired'))) {
            
            console.warn('⚠️ Access token expired. Attempting refresh...');
            auth.setCredentials({ refresh_token: user.tokens.refresh_token });
            
            const refreshResponse = await auth.refreshAccessToken();
            
            user.tokens = { ...user.tokens, ...refreshResponse.credentials };
            console.log('✅ Token refreshed successfully. Retrying upload...');

            await attemptUpload(user.tokens);
            
        } else {
            console.error('❌ Google Drive upload failed with unrecoverable error:', error.message);
            throw new Error(`Google Drive API error during upload: ${error.message}`);
        }
    }
}

// === ASYNC INITIALIZATION AND SERVER START ===
async function initializeClientAndStartServer() {
    console.log('⏳ Initializing WebTorrent client...');
    try {
        // Dynamic import to bypass the require() ESM restriction
        const WebTorrentModule = await import('webtorrent');
        const WebTorrent = WebTorrentModule.default;

        // Initialize WebTorrent client
        client = new WebTorrent();

        client.on('error', (err) => {
            console.error('WebTorrent Client Error:', err);
        });

        // Destroy any torrents that might have been automatically resumed from the previous run
        client.torrents.forEach(torrent => {
            torrent.destroy();
        });

        // Start Server
        app.listen(PORT, () => {
            console.log(`🚀 Server listening on http://localhost:${PORT}`);
            console.log(`WebTorrent client initialized.`);
        });
        
    } catch (e) {
        console.error("Critical Error: Could not load WebTorrent or start server:", e.message);
        // Do not proceed with app.listen if initialization failed
    }
}

// Start the whole application
initializeClientAndStartServer();