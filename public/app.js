let token = null;
let currentUser = null;

function showPage(pageId) {
    document.querySelectorAll(".page").forEach(p => p.style.display = "none");
    document.getElementById(pageId).style.display = "block";
}

// Navigation function
function navigateTo(pageId) {
    if (pageId === 'uploadPage' || pageId === 'videosPage') {
        if (!token) {
            showPage('loginPage');
            return;
        }
    }
    showPage(pageId);

    if (pageId === 'videosPage') {
        fetchVideos();
    }
}

// cognito registration functionality
function showRegisterForm() {
    document.getElementById("loginPage").style.display = "none";
    document.getElementById("registerPage").style.display = "block";
}

function showLoginForm() {
    document.getElementById("registerPage").style.display = "none";
    document.getElementById("confirmPage").style.display = "none";
    document.getElementById("loginPage").style.display = "block";
}

function showConfirmForm() {
    document.getElementById("registerPage").style.display = "none";
    document.getElementById("confirmPage").style.display = "block";
    // Pre-fill username
    document.getElementById("confirmUsername").value = sessionStorage.getItem('pendingUsername') || '';
}

// Handle registration
document.getElementById("registerForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("regUsername").value;
    const password = document.getElementById("regPassword").value;
    const email = document.getElementById("regEmail").value;

    try {
        const res = await fetch("/register", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, password, email })
        });

        const data = await res.json();
        if (res.ok) {
            document.getElementById("registerMessage").textContent = data.message;
            // Store username for confirmation step
            sessionStorage.setItem('pendingUsername', username);
            showConfirmForm();
        } else {
            document.getElementById("registerMessage").textContent = data.error;
        }
    } catch (error) {
        document.getElementById("registerMessage").textContent = "Registration failed: " + error.message;
    }
});

// Handle email confirmation
document.getElementById("confirmForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("confirmUsername").value;
    const confirmationCode = document.getElementById("confirmationCode").value;

    try {
        const res = await fetch("/confirm", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ username, confirmationCode })
        });

        const data = await res.json();
        if (res.ok) {
            document.getElementById("confirmMessage").textContent = data.message + " You can now log in.";
            sessionStorage.removeItem('pendingUsername');
            setTimeout(() => showLoginForm(), 2000);
        } else {
            document.getElementById("confirmMessage").textContent = data.error;
        }
    } catch (error) {
        document.getElementById("confirmMessage").textContent = "Confirmation failed: " + error.message;
    }
});

// Handle login
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
        if (res.ok) {
            token = data.token;
            currentUser = {
                username: data.username,
                email: data.email,
                role: data.role
            };
            document.getElementById("loginMessage").textContent = "Login successful!";
            document.getElementById("userInfo").textContent = `Welcome, ${data.username} (${data.role})`;
            showPage("uploadPage");
        } else {
            document.getElementById("loginMessage").textContent = data.error || "Login failed";
        }
    } catch (error) {
        document.getElementById("loginMessage").textContent = "Login failed: " + error.message;
    }
});

// Handle logout
function logout() {
    token = null;
    currentUser = null;
    document.getElementById("userInfo").textContent = "";
    showPage("loginPage");
}

// Handle upload
document.getElementById("uploadForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const file = document.getElementById("videoFile").files[0];
    if (!file) return;

    // Show upload progress
    document.getElementById("uploadMessage").textContent = "Uploading to S3...";

    const formData = new FormData();
    formData.append("video", file);

    try {
        const res = await fetch("/upload", {
            method: "POST",
            headers: { "Authorization": `Bearer ${token}` },
            body: formData
        });

        const data = await res.json();
        if (res.ok) {
            document.getElementById("uploadMessage").textContent = "Upload successful! File stored in S3. Video ID: " + data.id;
            document.getElementById("uploadForm").reset();
        } else {
            document.getElementById("uploadMessage").textContent = data.error || "Upload failed";
        }
    } catch (error) {
        document.getElementById("uploadMessage").textContent = "Upload failed: " + error.message;
    }
});

// Fetch videos and render list
async function fetchVideos() {
    try {
        const res = await fetch("/videos", {
            headers: { "Authorization": `Bearer ${token}` }
        });

        const list = document.getElementById("videoList");
        list.innerHTML = "";

        if (!res.ok) {
            list.innerHTML = "<li>Error loading videos</li>";
            return;
        }

        const videos = await res.json();

        if (videos.length === 0) {
            list.innerHTML = "<li>No videos found</li>";
            return;
        }

        videos.forEach(video => {
            const li = document.createElement("li");
            li.className = "video-item";

            // Video info
            const infoDiv = document.createElement("div");
            infoDiv.className = "video-info";
            infoDiv.innerHTML = `
                <strong>${video.originalName}</strong><br>
                Status: <span class="status-${video.status}">${video.status}</span><br>
                Format: ${video.format || 'Original'}<br>
                Created: ${new Date(video.createdAt).toLocaleString()}
            `;
            li.appendChild(infoDiv);

            // Actions based on status
            const actionsDiv = document.createElement("div");
            actionsDiv.className = "video-actions";

            if (video.status === "uploaded") {
                // Transcode button
                const btn = document.createElement("button");
                btn.textContent = "Transcode to";
                btn.onclick = () => transcodeVideo(video.id, select.value);

                // Create format selector
                const select = document.createElement("select");
                ["mp4", "avi", "mov"].forEach(f => {
                    const option = document.createElement("option");
                    option.value = f;
                    option.textContent = f.toUpperCase();
                    select.appendChild(option);
                });

                actionsDiv.appendChild(btn);
                actionsDiv.appendChild(select);
            }

            if (video.status === "completed") {
                const downloadBtn = document.createElement("button");
                downloadBtn.textContent = "Download";
                downloadBtn.onclick = async () => {
                    try {
                        const res = await fetch(`/download/${video.id}`, {
                            headers: { "Authorization": `Bearer ${token}` }
                        });

                        if (!res.ok) {
                            alert("Download failed: " + res.statusText);
                            return;
                        }

                        const data = await res.json();
                        window.open(data.downloadUrl, '_blank');
                    } catch (error) {
                        console.error('Download error:', error);
                        alert("Download failed: " + error.message);
                    }
                };
                actionsDiv.appendChild(downloadBtn);

                // View details button
                const detailsBtn = document.createElement("button");
                detailsBtn.textContent = "View Details";
                detailsBtn.onclick = () => showVideoDetails(video.id);
                actionsDiv.appendChild(detailsBtn);
            }

            if (video.status === "processing") {
                const statusSpan = document.createElement("span");
                statusSpan.textContent = "Processing...";
                statusSpan.className = "processing-status";
                actionsDiv.appendChild(statusSpan);

                // Add refresh button for processing videos
                const refreshBtn = document.createElement("button");
                refreshBtn.textContent = "Refresh Status";
                refreshBtn.onclick = () => checkVideoStatus(video.id);
                actionsDiv.appendChild(refreshBtn);
            }

            if (video.status === "error") {
                const errorSpan = document.createElement("span");
                errorSpan.textContent = "Error occurred";
                errorSpan.className = "error-status";
                actionsDiv.appendChild(errorSpan);

                // Retry button for errored videos
                const retryBtn = document.createElement("button");
                retryBtn.textContent = "Retry Transcoding";
                retryBtn.onclick = () => transcodeVideo(video.id, 'mp4');
                actionsDiv.appendChild(retryBtn);
            }

            li.appendChild(actionsDiv);
            list.appendChild(li);
        });
    } catch (error) {
        console.error('Error fetching videos:', error);
        document.getElementById("videoList").innerHTML = "<li>Error loading videos</li>";
    }
}

// Show video details with related videos
async function showVideoDetails(videoId) {
    try {
        const res = await fetch(`/videos/${videoId}`, {
            headers: { "Authorization": `Bearer ${token}` }
        });

        if (!res.ok) {
            alert("Error fetching video details");
            return;
        }

        const video = await res.json();

        // Create modal or display in a details section
        const detailsHtml = `
            <h3>Video Details: ${video.originalName}</h3>
            <p><strong>Status:</strong> ${video.status}</p>
            <p><strong>Format:</strong> ${video.format || 'Original'}</p>
            <p><strong>Created:</strong> ${new Date(video.createdAt).toLocaleString()}</p>
            
            <h4>Related YouTube Videos:</h4>
            <div id="relatedVideos">
                ${video.relatedVideos && video.relatedVideos.length > 0
            ? video.relatedVideos.map(v => `
                        <div class="related-video">
                            <a href="${v.link}" target="_blank">${v.title}</a>
                            <br>
                            <img src="${v.thumbnail}" alt="${v.title}" style="max-width: 120px;">
                        </div>
                    `).join('')
            : '<p>No related videos found</p>'
        }
            </div>
        `;

        // You might want to create a proper modal here
        alert(`Video Details:\n${video.originalName}\nStatus: ${video.status}`);
    } catch (error) {
        console.error('Error fetching video details:', error);
    }
}

// Check status of a specific video
async function checkVideoStatus(videoId) {
    try {
        const res = await fetch(`/videos/${videoId}/status`, {
            headers: { "Authorization": `Bearer ${token}` }
        });

        if (!res.ok) throw new Error('Status check failed');

        const statusData = await res.json();

        if (statusData.status === 'completed') {
            alert('Transcoding finished successfully!');
            fetchVideos();
        } else if (statusData.status === 'error') {
            alert('Transcoding failed. Please try again.');
            fetchVideos();
        } else {
            alert(`Current status: ${statusData.status}`);
        }
    } catch (error) {
        console.error("Status check error:", error);
        alert('Error checking status');
    }
}

// Transcode video
async function transcodeVideo(id, format) {
    try {
        const res = await fetch("/transcode", {
            method: "POST",
            headers: {
                "Content-Type": "application/json",
                "Authorization": `Bearer ${token}`
            },
            body: JSON.stringify({ id, format })
        });

        if (!res.ok) {
            const errorData = await res.json();
            throw new Error(errorData.error || 'Transcoding request failed');
        }

        alert('Transcoding started! The video will be processed in the background.');
        fetchVideos(); // Refresh the list to show processing status

        // Start polling for status updates
        const checkStatus = async () => {
            try {
                const statusRes = await fetch(`/videos/${id}/status`, {
                    headers: { "Authorization": `Bearer ${token}` }
                });

                if (!statusRes.ok) throw new Error('Status check failed');
                const statusData = await statusRes.json();

                if (statusData.status === 'completed') {
                    alert('Transcoding finished successfully!');
                    fetchVideos();
                } else if (statusData.status === 'error') {
                    alert('Transcoding failed. Please try again.');
                    fetchVideos();
                } else if (statusData.status === 'processing') {
                    setTimeout(checkStatus, 5000);
                }
            } catch (error) {
                console.error("Status check error:", error);
            }
        };

        setTimeout(checkStatus, 3000);

    } catch (error) {
        console.error("Transcoding error:", error);
        alert('Error starting transcoding: ' + error.message);
    }
}

// Initialize the app
document.addEventListener('DOMContentLoaded', function() {
    // Check if user is already logged in (from session storage)
    const savedToken = sessionStorage.getItem('userToken');
    const savedUser = sessionStorage.getItem('userInfo');

    if (savedToken && savedUser) {
        token = savedToken;
        currentUser = JSON.parse(savedUser);
        document.getElementById("userInfo").textContent = `Welcome, ${currentUser.username} (${currentUser.role})`;
        showPage("uploadPage");
    } else {
        showPage("loginPage");
    }
});