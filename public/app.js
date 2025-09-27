let token = null;
// Global variables for MFA
let mfaSession = null;
let mfaUsername = null;

function showPage(pageId) {
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });
    document.getElementById(pageId).classList.add('active');
}

// Registration flow
function showRegister() {
    showPage('registerPage');
}

function showConfirm() {
    showPage('confirmPage');
    document.getElementById('confirmUsername').value = sessionStorage.getItem('pendingUsername') || '';
}

// Register
document.getElementById('registerForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('regUsername').value;
    const password = document.getElementById('regPassword').value;
    const email = document.getElementById('regEmail').value;

    try {
        const res = await fetch('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password, email })
        });

        const data = await res.json();
        if (res.ok) {
            document.getElementById('registerMessage').textContent = data.message;
            sessionStorage.setItem('pendingUsername', username);
            showConfirm();
        } else {
            document.getElementById('registerMessage').textContent = data.error;
        }
    } catch (error) {
        document.getElementById('registerMessage').textContent = 'Registration failed';
    }
});

// Confirm email
document.getElementById('confirmForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('confirmUsername').value;
    const code = document.getElementById('confirmationCode').value;

    try {
        const res = await fetch('/confirm', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, confirmationCode: code })
        });

        const data = await res.json();
        if (res.ok) {
            document.getElementById('confirmMessage').textContent = data.message;
            setTimeout(() => showPage('loginPage'), 2000);
        } else {
            document.getElementById('confirmMessage').textContent = data.error;
        }
    } catch (error) {
        document.getElementById('confirmMessage').textContent = 'Confirmation failed';
    }
});

// Login
document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("username").value;
    const password = document.getElementById("password").value;

    try {
        const res = await fetch("/login", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password })
        });

        const data = await res.json();

        if (data.mfaRequired) {
            // Show MFA verification screen
            mfaSession = data.session;
            mfaUsername = data.username;
            showMfaVerification();
        }
        else if (res.ok) {
            token = data.token;
            document.getElementById("loginMessage").textContent = "Login successful!";
            showPage("uploadPage");
        } else {
            document.getElementById("loginMessage").textContent = data.error || "Login failed";
        }
    } catch (error) {
        document.getElementById("loginMessage").textContent = "Login failed";
    }
});

// Show MFA verification screen
function showMfaVerification() {
    document.getElementById("loginPage").style.display = "none";
    document.getElementById("mfaPage").style.display = "block";
}

// Handle MFA verification
document.getElementById("mfaForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = document.getElementById("mfaCode").value;

    const res = await fetch("/verify-mfa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
            username: mfaUsername,
            session: mfaSession,
            code: code
        })
    });

    const data = await res.json();
    if (res.ok) {
        token = data.token;
        showPage("uploadPage");
    } else {
        alert("Invalid code - please check your email and try again");
    }
});

// Upload
document.getElementById('uploadForm').addEventListener('submit', async (e) => {
    e.preventDefault();
    const file = document.getElementById('videoFile').files[0];
    if (!file) return;

    document.getElementById('uploadMessage').textContent = 'Uploading...';

    const formData = new FormData();
    formData.append('video', file);

    try {
        const res = await fetch('/upload', {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}` },
            body: formData
        });

        const data = await res.json();
        if (res.ok) {
            document.getElementById('uploadMessage').textContent = 'Uploaded! Video ID: ' + data.id;
            document.getElementById('uploadForm').reset();
        } else {
            document.getElementById('uploadMessage').textContent = data.error;
        }
    } catch (error) {
        document.getElementById('uploadMessage').textContent = 'Upload failed';
    }
});

// Fetch videos
async function fetchVideos() {
    if (!token) {
        showPage('loginPage');
        return;
    }

    try {
        const res = await fetch('/videos', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const videos = await res.json();
        const list = document.getElementById('videoList');
        list.innerHTML = '';

        videos.forEach(video => {
            const li = document.createElement('li');
            li.innerHTML = `
                <strong>${video.originalName}</strong>
                <span class="status-${video.status}">(${video.status})</span>
                <br>
                <small>Uploaded: ${new Date(video.createdAt).toLocaleString()}</small>
            `;

            if (video.status === 'uploaded') {
                const select = document.createElement('select');
                ['mp4', 'avi', 'mov'].forEach(format => {
                    const option = document.createElement('option');
                    option.value = format;
                    option.textContent = format.toUpperCase();
                    select.appendChild(option);
                });

                const btn = document.createElement('button');
                btn.textContent = 'Transcode';
                btn.onclick = () => transcodeVideo(video.id, select.value);

                li.appendChild(select);
                li.appendChild(btn);
            }

            if (video.status === 'completed') {
                const downloadBtn = document.createElement('button');
                downloadBtn.textContent = 'Download';
                downloadBtn.onclick = () => downloadVideo(video.id);
                li.appendChild(downloadBtn);

                const detailsBtn = document.createElement('button');
                detailsBtn.textContent = 'View Details';
                detailsBtn.onclick = () => showVideoDetails(video.id);
                li.appendChild(detailsBtn);
            }

            if (video.status === 'processing') {
                const statusBtn = document.createElement('button');
                statusBtn.textContent = 'Check Status';
                statusBtn.onclick = () => checkStatus(video.id);
                li.appendChild(statusBtn);
            }

            list.appendChild(li);
        });
    } catch (error) {
        document.getElementById('videoList').innerHTML = '<li>Error loading videos</li>';
    }
}

// Transcode video
async function transcodeVideo(id, format) {
    try {
        const res = await fetch('/transcode', {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ id, format })
        });

        if (res.ok) {
            alert('Transcoding started!');
            fetchVideos();

            // Check status every 5 seconds
            const check = setInterval(async () => {
                const statusRes = await fetch(`/videos/${id}/status`, {
                    headers: { 'Authorization': `Bearer ${token}` }
                });
                const status = await statusRes.json();

                if (status.status === 'completed' || status.status === 'error') {
                    clearInterval(check);
                    fetchVideos();
                    if (status.status === 'completed') alert('Transcoding completed!');
                }
            }, 5000);
        } else {
            alert('Transcoding failed');
        }
    } catch (error) {
        alert('Error starting transcoding');
    }
}

// Download video
async function downloadVideo(id) {
    try {
        const res = await fetch(`/download/${id}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await res.json();
        if (res.ok) {
            window.open(data.downloadUrl, '_blank');
        } else {
            alert('Download failed');
        }
    } catch (error) {
        alert('Download error');
    }
}

// Check status
async function checkStatus(id) {
    try {
        const res = await fetch(`/videos/${id}/status`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const data = await res.json();
        alert(`Current status: ${data.status}`);
        if (data.status !== 'processing') {
            fetchVideos();
        }
    } catch (error) {
        alert('Error checking status');
    }
}

// Show video details
async function showVideoDetails(id) {
    try {
        const res = await fetch(`/videos/${id}`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const video = await res.json();
        let details = `Video: ${video.originalName}\nStatus: ${video.status}\nFormat: ${video.format}\n\nRelated Videos:\n`;

        if (video.relatedVideos && video.relatedVideos.length > 0) {
            video.relatedVideos.forEach(v => {
                details += `- ${v.title}\n  ${v.link}\n\n`;
            });
        } else {
            details += 'No related videos found';
        }

        alert(details);
    } catch (error) {
        alert('Error loading details');
    }
}

// Logout
function logout() {
    token = null;
    showPage('loginPage');
}

// Initialize - show login page by default
showPage('loginPage');