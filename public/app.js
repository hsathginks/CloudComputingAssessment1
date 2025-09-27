let token = null;

// Global variables for MFA
let mfaSession = null;
let mfaUsername = null;

let userRole = null;

function showPage(pageId) {
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });
    document.getElementById(pageId).classList.add('active');

    // Show/hide admin navigation based on role
    const adminNav = document.getElementById('adminNav');
    if (adminNav) {
        adminNav.style.display = userRole === 'admin' ? 'inline-block' : 'none';
        console.log('Admin nav visibility:', adminNav.style.display, 'userRole:', userRole);
    }
}

// Debug function to check user role
// Debug function to check login response
function debugLoginResponse(data) {
    console.log('Login response:', data);
    console.log('Role received:', data.role);
    console.log('Token received:', !!data.token);
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
            debugLoginResponse(data);
            token = data.token;
            userRole = data.role;
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
    showPage("mfaPage");
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
        debugLoginResponse(data);
        token = data.token;
        userRole = data.role;
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

// Show video analytics
async function showVideoAnalytics(videoId) {
    try {
        const res = await fetch(`/videos/${videoId}/analytics`, {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const analytics = await res.json();
        if (res.ok) {
            let details = `Analytics for Video:\n\n`;
            if (analytics.length > 0) {
                analytics.forEach(event => {
                    details += `${event.action} - ${new Date(event.timestamp).toLocaleString()} by ${event.userId}\n`;
                });
            } else {
                details += 'No analytics data available';
            }
            alert(details);
        } else {
            alert('Error loading analytics: ' + analytics.error);
        }
    } catch (error) {
        alert('Error loading analytics');
    }
}

// ADMIN FUNCTIONS

// Fetch admin statistics
async function fetchAdminStats() {
    console.log('fetchAdminStats called - userRole:', userRole);
    if (!token) {
        alert('Please login first');
        showPage('loginPage');
        return;
    }

    if (userRole !== 'admin') {
        alert('Admin access required. Your current role: ' + (userRole || 'unknown'));
        return;
    }

    try {
        const res = await fetch('/admin/stats', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const stats = await res.json();
        const statsDiv = document.getElementById('adminStats');

        if (res.ok) {
            statsDiv.innerHTML = `
                <h3>System Statistics</h3>
                <div style="display: grid; grid-template-columns: repeat(3, 1fr); gap: 15px;">
                    <div style="background: white; padding: 10px; border-radius: 5px; text-align: center;">
                        <h4 style="margin: 0; color: #333;">${stats.total_videos}</h4>
                        <p style="margin: 5px 0 0 0; color: #666;">Total Videos</p>
                    </div>
                    <div style="background: white; padding: 10px; border-radius: 5px; text-align: center;">
                        <h4 style="margin: 0; color: #28a745;">${stats.completed}</h4>
                        <p style="margin: 5px 0 0 0; color: #666;">Completed</p>
                    </div>
                    <div style="background: white; padding: 10px; border-radius: 5px; text-align: center;">
                        <h4 style="margin: 0; color: #ffc107;">${stats.processing}</h4>
                        <p style="margin: 5px 0 0 0; color: #666;">Processing</p>
                    </div>
                </div>
                <div style="margin-top: 15px;">
                    <p><strong>Uploaded:</strong> ${stats.uploaded}</p>
                    <p><strong>Errors:</strong> ${stats.error}</p>
                    <p><strong>Unique Users:</strong> ${stats.unique_users}</p>
                </div>
            `;
        } else {
            statsDiv.innerHTML = '<div style="color: red;">Error loading stats: ' + stats.error + '</div>';
        }
    } catch (error) {
        console.error('Error fetching admin stats:', error);
        document.getElementById('adminStats').innerHTML = '<div style="color: red;">Error loading stats</div>';
    }
}

// Fetch all videos for admin view
async function fetchAllVideos() {
    console.log('fetchAllVideos called - userRole:', userRole);
    if (!token) {
        alert('Please login first');
        showPage('loginPage');
        return;
    }

    if (userRole !== 'admin') {
        alert('Admin access required. Your current role: ' + (userRole || 'unknown'));
        return;
    }

    try {
        const res = await fetch('/admin/all-videos', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const videos = await res.json();
        const list = document.getElementById('adminVideoList');
        list.innerHTML = '';

        if (res.ok) {
            if (videos.length === 0) {
                list.innerHTML = '<li>No videos found in the system</li>';
                return;
            }

            videos.forEach(video => {
                const li = document.createElement('li');
                li.style.marginBottom = '15px';
                li.style.padding = '15px';
                li.style.border = '1px solid #ddd';
                li.style.borderRadius = '5px';
                li.style.backgroundColor = '#fff';

                // Create status color coding
                let statusColor = '#666';
                switch(video.status) {
                    case 'completed': statusColor = '#28a745'; break;
                    case 'processing': statusColor = '#ffc107'; break;
                    case 'error': statusColor = '#dc3545'; break;
                    case 'uploaded': statusColor = '#007bff'; break;
                }

                li.innerHTML = `
                    <div style="display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 10px;">
                        <div style="flex: 1;">
                            <strong style="font-size: 16px;">${video.originalName}</strong>
                            <br>
                            <span style="color: #666; font-size: 14px;">Owner: <strong>${video.owner}</strong></span>
                            <br>
                            <span style="color: ${statusColor}; font-weight: bold; text-transform: uppercase; font-size: 12px;">${video.status}</span>
                            ${video.format ? `<span style="color: #666; margin-left: 10px;">Format: ${video.format}</span>` : ''}
                        </div>
                        <div style="text-align: right;">
                            <div style="font-size: 12px; color: #666;">
                                ${new Date(video.createdAt).toLocaleDateString()}<br>
                                ${new Date(video.createdAt).toLocaleTimeString()}
                            </div>
                        </div>
                    </div>
                    <div style="margin-top: 10px;">
                        <button onclick="viewUserVideos('${video.owner}')" 
                                style="background: #007bff; color: white; border: none; padding: 5px 10px; border-radius: 3px; margin-right: 5px;">
                            View User's Videos
                        </button>
                        <button onclick="deleteVideoAdmin('${video.id}', '${video.originalName}')" 
                                style="background: #dc3545; color: white; border: none; padding: 5px 10px; border-radius: 3px;">
                            Delete Video
                        </button>
                    </div>
                `;
                list.appendChild(li);
            });
        } else {
            list.innerHTML = '<li style="color: red;">Error loading videos: ' + videos.error + '</li>';
        }
    } catch (error) {
        console.error('Error fetching all videos:', error);
        document.getElementById('adminVideoList').innerHTML = '<li style="color: red;">Error loading videos</li>';
    }
}

// Fetch analytics summary
async function fetchAnalyticsSummary() {
    console.log('fetchAnalyticsSummary called - userRole:', userRole);
    if (!token) {
        alert('Please login first');
        showPage('loginPage');
        return;
    }

    if (userRole !== 'admin') {
        alert('Admin access required. Your current role: ' + (userRole || 'unknown'));
        return;
    }

    try {
        const res = await fetch('/admin/analytics/summary', {
            headers: { 'Authorization': `Bearer ${token}` }
        });

        const summary = await res.json();
        const summaryDiv = document.getElementById('analyticsSummary');

        if (res.ok) {
            summaryDiv.innerHTML = `
                <h3>Analytics Summary</h3>
                <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 15px; margin-bottom: 20px;">
                    <div style="background: white; padding: 10px; border-radius: 5px; text-align: center;">
                        <h4 style="margin: 0; color: #007bff;">${summary.totalEvents}</h4>
                        <p style="margin: 5px 0 0 0; color: #666;">Total Events</p>
                    </div>
                    <div style="background: white; padding: 10px; border-radius: 5px; text-align: center;">
                        <h4 style="margin: 0; color: #28a745;">${summary.uploads}</h4>
                        <p style="margin: 5px 0 0 0; color: #666;">Uploads</p>
                    </div>
                    <div style="background: white; padding: 10px; border-radius: 5px; text-align: center;">
                        <h4 style="margin: 0; color: #ffc107;">${summary.downloads}</h4>
                        <p style="margin: 5px 0 0 0; color: #666;">Downloads</p>
                    </div>
                    <div style="background: white; padding: 10px; border-radius: 5px; text-align: center;">
                        <h4 style="margin: 0; color: #17a2b8;">${summary.transcodes}</h4>
                        <p style="margin: 5px 0 0 0; color: #666;">Transcodes</p>
                    </div>
                </div>
                <div style="background: white; padding: 15px; border-radius: 5px;">
                    <p><strong>Unique Active Users:</strong> ${summary.uniqueUsers}</p>
                    
                    <h4>Recent Activity:</h4>
                    <div style="max-height: 200px; overflow-y: auto;">
                        ${summary.recentActivity.length > 0 ?
                summary.recentActivity.map(activity => `
                                <div style="padding: 8px; border-bottom: 1px solid #eee; display: flex; justify-content: space-between;">
                                    <span><strong>${activity.action}</strong> by ${activity.userId}</span>
                                    <span style="color: #666; font-size: 12px;">${activity.date}</span>
                                </div>
                            `).join('') :
                '<p>No recent activity</p>'
            }
                    </div>
                </div>
            `;
        } else {
            summaryDiv.innerHTML = '<div style="color: red;">Error loading analytics: ' + summary.error + '</div>';
        }
    } catch (error) {
        console.error('Error fetching analytics summary:', error);
        document.getElementById('analyticsSummary').innerHTML = '<div style="color: red;">Error loading analytics</div>';
    }
}

// Logout
function logout() {
    token = null;
    showPage('loginPage');
}

// Initialize - show login page by default
showPage('loginPage');