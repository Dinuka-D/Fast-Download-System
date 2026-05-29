const express = require('express');
const session = require('express-session');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const { google } = require('googleapis');
const dotenv = require('dotenv'); 

// --- 1. FIREBASE IMPORTS ---
const { initializeApp } = require('firebase/app');
const firestore = require('firebase/firestore');
let { getFirestore, doc, setDoc, getDoc, updateDoc, collection, query, where, getDocs, onSnapshot } = firestore;

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;
const SESSION_SECRET = process.env.SESSION_SECRET || 'torrent-drive-secret-2024';

// Global variable for the WebTorrent client instance
let client;

// Define the temporary downloads directory
const DOWNLOAD_PATH = path.join(__dirname, 'downloads');
const UPLOADS_PATH = path.join(__dirname, 'uploads');

// Startup cleanup helper to empty temporary directories
function cleanupDirectory(dirPath) {
    if (fs.existsSync(dirPath)) {
        try {
            fs.rmSync(dirPath, { recursive: true, force: true });
            console.log(`🧹 Cleaned temporary folder: ${dirPath}`);
        } catch (err) {
            console.warn(`⚠️ Failed to clean directory ${dirPath}:`, err.message);
        }
    }
    fs.mkdirSync(dirPath, { recursive: true });
}

// Perform startup cleanup
cleanupDirectory(DOWNLOAD_PATH);
cleanupDirectory(UPLOADS_PATH);

// === GOOGLE CONFIG (Reading from .env) ===
const GOOGLE_CLIENT_ID = process.env.GOOGLE_CLIENT_ID;
const GOOGLE_CLIENT_SECRET = process.env.GOOGLE_CLIENT_SECRET;
const REDIRECT_URI = process.env.REDIRECT_URI;

console.log('🔧 Google OAuth Config:');
console.log('Client ID:', GOOGLE_CLIENT_ID ? '✅ Set from .env' : '❌ Missing');
console.log('Redirect URI:', REDIRECT_URI);

const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);

// --- 2. FIREBASE INITIALIZATION & LOCAL DB FALLBACK ---
const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY || 'PLACEHOLDER_API_KEY',
    authDomain: process.env.FIREBASE_AUTH_DOMAIN || 'localhost',
    projectId: process.env.FIREBASE_PROJECT_ID || 'torrent-drive-project',
};

let db;
let useLocalDb = false;

// Check if Firebase is configured (not using placeholders)
const isFirebaseConfigured = process.env.FIREBASE_API_KEY && 
                             process.env.FIREBASE_API_KEY !== 'YOUR_FIREBASE_API_KEY_HERE' &&
                             process.env.FIREBASE_API_KEY !== 'PLACEHOLDER_API_KEY';

if (isFirebaseConfigured) {
    try {
        const firebaseApp = initializeApp(firebaseConfig);
        db = getFirestore(firebaseApp);
        console.log("🔥 Firebase Firestore initialized successfully.");
    } catch (e) {
        console.warn("⚠️ Firebase init failed, falling back to Local In-Memory DB:", e.message);
        useLocalDb = true;
    }
} else {
    console.log("ℹ️ Using Local In-Memory Database (No Firebase setup required for local testing!)");
    useLocalDb = true;
}

// Local In-Memory database store
const memoryStore = {
    users: {},
    downloads: {}
};

// SSE listeners registered for real-time updates
const sseListeners = new Set();

function notifySseListeners() {
    sseListeners.forEach(listener => {
        try { listener(); } catch (e) { console.error("SSE notification error:", e); }
    });
}

// Mock Firestore functions
const mockDoc = (dbInstance, collectionPath, id) => {
    return { path: `${collectionPath}/${id}`, collectionPath, id };
};

const mockSetDoc = async (docRef, data, options = {}) => {
    const { collectionPath, id } = docRef;
    if (collectionPath.includes('downloads')) {
        memoryStore.downloads[id] = { ...data, infoHash: id };
        notifySseListeners();
    } else {
        memoryStore.users[id] = data;
    }
    return true;
};

const mockGetDoc = async (docRef) => {
    const { collectionPath, id } = docRef;
    let data;
    if (collectionPath.includes('downloads')) {
        data = memoryStore.downloads[id];
    } else {
        data = memoryStore.users[id];
    }
    return {
        exists: () => !!data,
        data: () => data
    };
};

const mockUpdateDoc = async (docRef, data) => {
    const { collectionPath, id } = docRef;
    if (collectionPath.includes('downloads')) {
        memoryStore.downloads[id] = { ...memoryStore.downloads[id], ...data };
        notifySseListeners();
    } else {
        memoryStore.users[id] = { ...memoryStore.users[id], ...data };
    }
    return true;
};

const mockCollection = (dbInstance, collectionPath) => {
    return { collectionPath };
};

const mockGetDocs = async (collectionRef) => {
    const docs = [];
    Object.values(memoryStore.downloads).forEach(item => {
        docs.push({ data: () => item });
    });
    return docs;
};

const mockOnSnapshot = (collectionRef, callback) => {
    const listener = () => {
        const snapshot = [];
        Object.values(memoryStore.downloads).forEach(item => {
            snapshot.push({ data: () => item });
        });
        callback(snapshot);
    };
    
    sseListeners.add(listener);
    listener(); // Initial call
    
    return () => {
        sseListeners.delete(listener);
    };
};

// Re-assign imported Firestore functions to mock counterparts if using local DB
if (useLocalDb) {
    doc = mockDoc;
    setDoc = mockSetDoc;
    getDoc = mockGetDoc;
    updateDoc = mockUpdateDoc;
    collection = mockCollection;
    getDocs = mockGetDocs;
    onSnapshot = mockOnSnapshot;
}
// --- END FIREBASE INITIALIZATION & LOCAL DB FALLBACK ---


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

// Get all downloads for the authenticated user
app.get('/api/downloads', isAuthenticated, async (req, res) => {
    try {
        const userId = req.session.user.id;
        const downloadsRef = collection(db, `artifacts/${process.env.__app_id}/users/${userId}/downloads`);
        const qSnapshot = await getDocs(downloadsRef);
        const downloads = [];
        qSnapshot.forEach((doc) => {
            downloads.push(doc.data());
        });
        res.json(downloads);
    } catch (error) {
        console.error('Error fetching downloads:', error);
        res.status(500).json({ error: 'Failed to fetch downloads.' });
    }
});

// Real-time downloads stream using Server-Sent Events (SSE)
app.get('/api/downloads/stream', isAuthenticated, (req, res) => {
    const userId = req.session.user.id;
    
    // Set headers for SSE
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    console.log(`📶 SSE Client connected: User ${userId}`);

    const downloadsRef = collection(db, `artifacts/${process.env.__app_id}/users/${userId}/downloads`);
    
    // Setup Firestore onSnapshot listener
    const unsubscribe = onSnapshot(downloadsRef, (snapshot) => {
        const downloads = [];
        snapshot.forEach((doc) => {
            downloads.push(doc.data());
        });
        
        // Write event to the client
        res.write(`data: ${JSON.stringify(downloads)}\n\n`);
    }, (error) => {
        console.error(`❌ SSE Firestore error for user ${userId}:`, error);
        res.write(`event: error\ndata: ${JSON.stringify({ error: error.message })}\n\n`);
    });

    // Cleanup when client disconnects
    req.on('close', () => {
        console.log(`🔌 SSE Client disconnected: User ${userId}`);
        unsubscribe();
    });
});

const https = require('https');

// Helper to make https GET request returning JSON
function httpsGetJson(url) {
    return new Promise((resolve, reject) => {
        https.get(url, { headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    resolve(JSON.parse(data));
                } catch (e) {
                    reject(new Error(`Failed to parse JSON response: ${e.message}`));
                }
            });
        }).on('error', (err) => reject(err));
    });
}

// Torrent search using Apibay API (free open source pirate bay API)
app.get('/api/search', isAuthenticated, async (req, res) => {
    const { query } = req.query;
    if (!query) {
        return res.status(400).json({ error: 'Search query is required.' });
    }

    try {
        const searchUrl = `https://apibay.org/q.php?q=${encodeURIComponent(query)}`;
        const data = await httpsGetJson(searchUrl);

        if (!Array.isArray(data) || (data.length === 1 && data[0].id === '0' && data[0].name === 'No results found')) {
            return res.json([]);
        }

        const results = data.map(item => {
            const infoHash = item.info_hash;
            const name = item.name;
            const size = parseInt(item.size) || 0;
            const seeders = parseInt(item.seeders) || 0;
            const leechers = parseInt(item.leechers) || 0;

            const magnet = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(name)}&tr=udp%3A%2F%2Ftracker.coppersurfer.tk%3A6969%2Fannounce&tr%3Audp%3A%2F%2F9.rarbg.to%3A2710%2Fannounce&tr%3Audp%3A%2F%2Ftracker.opentrackr.org%3A1337%2Fannounce&tr%3Audp%3A%2F%2Ftracker.leechers-paradise.org%3A6969%2Fannounce`;

            return {
                name,
                size,
                seeders,
                leechers,
                magnet,
                infoHash
            };
        });

        res.json(results.slice(0, 30));
    } catch (error) {
        console.error('Torrent search failed:', error);
        res.status(500).json({ error: 'Failed to search torrents.' });
    }
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

        // Securely store user profile and OAuth credentials in Firestore
        const userRef = doc(db, `artifacts/${process.env.__app_id}/users`, userInfo.data.id);
        await setDoc(userRef, {
            id: userInfo.data.id,
            name: userInfo.data.name,
            email: userInfo.data.email,
            picture: userInfo.data.picture,
            tokens: tokens,
            updatedAt: new Date().toISOString()
        }, { merge: true }).catch(e => console.error("Firestore user credentials store failed:", e));

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

// Helper to format remaining time in seconds to human readable text
function formatETA(seconds) {
    if (!isFinite(seconds) || isNaN(seconds) || seconds <= 0) return 'Calculating...';
    if (seconds < 60) return `${Math.round(seconds)}s remaining`;
    const minutes = Math.floor(seconds / 60);
    const remainingSeconds = Math.round(seconds % 60);
    if (minutes < 60) return `${minutes}m ${remainingSeconds}s remaining`;
    const hours = Math.floor(minutes / 60);
    const remainingMinutes = minutes % 60;
    return `${hours}h ${remainingMinutes}m remaining`;
}

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
                eta: 'Calculating...'
            };
            
            // --- FIREBASE: Write initial job state ---
            const jobRef = doc(db, `artifacts/${process.env.__app_id}/users/${user.id}/downloads`, torrent.infoHash);
            setDoc(jobRef, initialDownload).catch(e => console.error("Firestore initial write failed:", e));

            console.log(`🟢 Starting new torrent: ${torrent.name}`);

            torrent.on('ready', () => {
                const totalFilesCount = torrent.files.length;
                const totalSize = torrent.length;
                
                const updateReady = {
                    status: 'downloading',
                    fileSize: totalSize,
                    filesCount: totalFilesCount,
                    fileName: torrent.files.length === 1 ? torrent.files[0].name : `${torrent.name} (${totalFilesCount} files)`
                };
                updateDoc(jobRef, updateReady).catch(e => console.error("Firestore ready update failed:", e));
                
                console.log(`📢 Torrent ready: ${torrent.name} containing ${totalFilesCount} files. Starting Drive upload stream...`);

                // Start the sequential multi-file upload stream in the background
                uploadMultipleToDrive(jobRef, user, torrent)
                    .then(() => {
                        console.log(`✅ Drive Upload Stream FINISHED for: ${torrent.name}`);
                        
                        // Check if cancelled first to avoid overwriting cancelled status
                        getDoc(jobRef).then((snap) => {
                            if (snap.exists() && snap.data().status === 'cancelled') {
                                console.log(`🛑 Upload completed but torrent was already cancelled by the user.`);
                                return;
                            }
                            
                            // Final update to Firestore
                            updateDoc(jobRef, {
                                status: 'completed',
                                progress: 100,
                                uploadSpeed: 0,
                            }).catch(e => console.error("Firestore completion update failed:", e));
                        });

                        // Clean up local files after successful upload stream completion
                        const torrentFolder = path.join(DOWNLOAD_PATH, torrent.name);
                        if (fs.existsSync(torrentFolder)) {
                            fs.rmSync(torrentFolder, { recursive: true, force: true });
                            console.log(`🗑️ Cleaned up local files for: ${torrent.name}`);
                        }
                    })
                    .catch(error => {
                        // Check if cancelled first to avoid overwriting cancelled status
                        getDoc(jobRef).then((snap) => {
                            if (snap.exists() && snap.data().status === 'cancelled') {
                                console.log(`🛑 Stream error caught but ignored since status is already cancelled.`);
                                return;
                            }
                            
                            updateDoc(jobRef, {
                                status: 'failed',
                                error: `Drive Upload Failed: ${error.message}`,
                            }).catch(e => console.error("Firestore failure update failed:", e));
                            console.error(`❌ Drive Upload Stream Failed: ${torrent.name}`, error);
                        });
                    });
            });
            
            torrent.on('download', () => {
                // Throttle Firestore updates to prevent excessive writes
                if (Date.now() % 500 < 50) { // Update every 500ms
                    const remainingBytes = torrent.length - torrent.downloaded;
                    let etaText = 'Calculating...';
                    if (torrent.downloadSpeed > 0) {
                        const etaSeconds = remainingBytes / torrent.downloadSpeed;
                        etaText = formatETA(etaSeconds);
                    }

                    const updateDownload = {
                        progress: Math.round(torrent.progress * 100),
                        downloadSpeed: torrent.downloadSpeed,
                        peers: torrent.numPeers,
                        status: 'downloading',
                        eta: etaText
                    };
                    updateDoc(jobRef, updateDownload).catch(e => console.error("Firestore download update failed:", e));
                }
            });

            torrent.on('done', () => {
                console.log(`⭐ Local download 100% complete. Waiting for Drive stream to close...`);
            });

            torrent.on('error', (err) => {
                // Check if cancelled first to avoid overwriting cancelled status
                getDoc(jobRef).then((snap) => {
                    if (snap.exists() && snap.data().status === 'cancelled') {
                        return;
                    }
                    updateDoc(jobRef, {
                        status: 'failed',
                        error: err.message,
                    }).catch(e => console.error("Firestore torrent error update failed:", e));
                });
                console.error(`❌ Torrent error for ${torrent.name}:`, err);
            });
            
            resolve();
        }, (err) => {
            reject(err);
        });
    });
}

// === MULTI-FILE UPLOAD STREAMING LOGIC ===
async function uploadMultipleToDrive(jobRef, user, torrent) {
    const auth = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET, REDIRECT_URI);
    
    const attemptUpload = async (tokens) => {
        auth.setCredentials(tokens);
        const drive = google.drive({ version: 'v3', auth });
        
        let parentFolderId = null;
        
        // If there are multiple files, create a parent folder in Google Drive
        if (torrent.files.length > 1) {
            console.log(`📁 Creating parent folder in Drive for torrent: ${torrent.name}`);
            const folderMetadata = {
                name: torrent.name,
                mimeType: 'application/vnd.google-apps.folder'
            };
            const folderResponse = await drive.files.create({
                resource: folderMetadata,
                fields: 'id'
            });
            parentFolderId = folderResponse.data.id;
            
            // Save the folder view/download link to Firestore
            const folderViewLink = `https://drive.google.com/drive/folders/${parentFolderId}`;
            await updateDoc(jobRef, { driveLink: folderViewLink }).catch(e => console.error("Firestore folder link update failed:", e));
        }
        
        const totalSize = torrent.length;
        let cumulativeUploadedBytes = 0;
        let lastUpdateTime = Date.now();
        let lastCumulativeBytes = 0;
        
        // Map to keep track of created subfolders inside the parent folder (for nested structures)
        const subfoldersCache = {};

        // Sequential helper to find/create nested subfolders in Drive
        async function getOrCreateSubfolders(filePathParts) {
            let currentParentId = parentFolderId;
            let currentPath = '';
            
            // If the file path doesn't have folder segments, return the top-level parent folder
            if (filePathParts.length <= 1) {
                return currentParentId;
            }
            
            // Traverse folders (excluding the actual file name)
            for (let i = 0; i < filePathParts.length - 1; i++) {
                const folderName = filePathParts[i];
                currentPath = currentPath ? `${currentPath}/${folderName}` : folderName;
                
                if (subfoldersCache[currentPath]) {
                    currentParentId = subfoldersCache[currentPath];
                } else {
                    console.log(`📁 Recreating subfolder in Drive: ${folderName}`);
                    const folderMetadata = {
                        name: folderName,
                        mimeType: 'application/vnd.google-apps.folder',
                        parents: currentParentId ? [currentParentId] : []
                    };
                    const subfolder = await drive.files.create({
                        resource: folderMetadata,
                        fields: 'id'
                    });
                    const subfolderId = subfolder.data.id;
                    subfoldersCache[currentPath] = subfolderId;
                    currentParentId = subfolderId;
                }
            }
            return currentParentId;
        }

        // Sequential multi-file upload
        for (let i = 0; i < torrent.files.length; i++) {
            const file = torrent.files[i];
            
            // Check if cancelled before starting upload of this file
            const jobSnap = await getDoc(jobRef);
            if (jobSnap.exists() && jobSnap.data().status === 'cancelled') {
                throw new Error('Upload aborted because the transfer was cancelled.');
            }

            console.log(`📤 Streaming file ${i + 1}/${torrent.files.length}: ${file.path} (${(file.length / (1024*1024)).toFixed(2)} MB)`);
            
            const pathParts = file.path.split('/');
            const targetParentId = await getOrCreateSubfolders(pathParts);
            
            const fileStream = file.createReadStream();
            const fileMetadata = {
                name: pathParts[pathParts.length - 1],
                parents: targetParentId ? [targetParentId] : []
            };

            let fileUploadedBytes = 0;

            const response = await drive.files.create({
                resource: fileMetadata,
                media: {
                    mimeType: file.mime || 'application/octet-stream',
                    body: fileStream
                },
                resumable: true,
                fields: 'id, webContentLink, webViewLink, name'
            }, {
                chunkSize: 10 * 1024 * 1024, // 10MB optimal chunk size
                onUploadProgress: (event) => {
                    const bytesReadForThisFile = event.bytesRead;
                    const deltaUploaded = bytesReadForThisFile - fileUploadedBytes;
                    fileUploadedBytes = bytesReadForThisFile;
                    cumulativeUploadedBytes += deltaUploaded;

                    const currentTime = Date.now();
                    const timeElapsedSeconds = (currentTime - lastUpdateTime) / 1000;
                    
                    if (currentTime % 500 < 50) {
                        const uploadSpeed = timeElapsedSeconds > 0 ? (cumulativeUploadedBytes - lastCumulativeBytes) / timeElapsedSeconds : 0;
                        const overallProgress = Math.min(99, Math.round((cumulativeUploadedBytes / totalSize) * 100));
                        
                        const remainingBytes = totalSize - cumulativeUploadedBytes;
                        let etaText = 'Calculating...';
                        if (uploadSpeed > 0) {
                            const etaSeconds = remainingBytes / uploadSpeed;
                            etaText = formatETA(etaSeconds);
                        }

                        updateDoc(jobRef, {
                            uploadedBytes: cumulativeUploadedBytes,
                            uploadSpeed: uploadSpeed,
                            progress: overallProgress,
                            status: 'uploading',
                            eta: etaText,
                            currentFile: file.name
                        }).catch(e => console.error("Firestore upload update failed:", e));

                        lastUpdateTime = currentTime;
                        lastCumulativeBytes = cumulativeUploadedBytes;
                    }
                }
            });

            if (torrent.files.length === 1) {
                await updateDoc(jobRef, {
                    driveLink: response.data.webContentLink || response.data.webViewLink,
                    fileName: response.data.name
                }).catch(e => console.error("Firestore link update failed:", e));
            }
        }
    };

    try {
        await attemptUpload(user.tokens);
    } catch (error) {
        if (user.tokens.refresh_token && (error.message.includes('401') || error.message.includes('invalid_grant') || error.message.includes('Token has been expired'))) {
            console.warn('⚠️ Access token expired. Attempting refresh...');
            auth.setCredentials({ refresh_token: user.tokens.refresh_token });
            
            const refreshResponse = await auth.refreshAccessToken();
            user.tokens = { ...user.tokens, ...refreshResponse.credentials };
            
            const userRef = doc(db, `artifacts/${process.env.__app_id}/users`, user.id);
            await updateDoc(userRef, { tokens: user.tokens }).catch(e => console.error("Firestore token sync failed:", e));
            console.log('✅ Token refreshed and synced successfully. Retrying upload...');

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