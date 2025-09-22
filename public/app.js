let token = null;

function showPage(pageId) {
    document.querySelectorAll(".page").forEach(p => p.style.display = "none");
    document.getElementById(pageId).style.display = "block";
}

// Handle login
document.getElementById("loginForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    const username = document.getElementById("username").value;
    const password = document.getElementById("password").value;

    const res = await fetch("/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password })
    });

    const data = await res.json();
    if (res.ok) {
        token = data.token;
        document.getElementById("loginMessage").textContent = "Login successful!";
        showPage("uploadPage");
    } else {
        document.getElementById("loginMessage").textContent = data.error || "Login failed";
    }
});

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
            document.getElementById("uploadMessage").textContent = "Upload successful! File stored in S3.";
        } else {
            document.getElementById("uploadMessage").textContent = data.error || "Upload failed";
        }
    } catch (error) {
        document.getElementById("uploadMessage").textContent = "Upload failed: " + error.message;
    }
});

// Fetch related videos from youtube api
async function fetchRelatedVideos(originalName, containerDiv) {
    try {
        const res = await fetch(`/youtube?query=${encodeURIComponent(originalName)}`, {
            headers: { "Authorization": `Bearer ${token}` }
        });

        if (!res.ok) {
            containerDiv.innerHTML = "<p>Related videos not available</p>";
            return;
        }

        const data = await res.json();
        containerDiv.innerHTML = ""; // clear old content

        data.items.forEach(video => {
            const a = document.createElement("a");
            a.href = `https://www.youtube.com/watch?v=${video.id.videoId}`;
            a.target = "_blank";
            a.textContent = video.snippet.title;
            containerDiv.appendChild(a);
            containerDiv.appendChild(document.createElement("br"));
        });
    } catch (err) {
        console.error(err);
        containerDiv.innerHTML = "<p>Error loading related videos</p>";
    }
}

// Fetch videos and render list
async function fetchVideos() {
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

    videos.forEach(video => {
        const li = document.createElement("li");
        li.textContent = `${video.originalName} [${video.status}]`;

        if (video.status === "uploaded") {
            // Transcode button
            const btn = document.createElement("button");
            btn.textContent = "Transcode to";
            btn.onclick = () => transcodeVideo(video.id, select.value);

            // Create format selector
            const select = document.createElement("select");
            ["mp4", "mp3", "avi", "mov"].forEach(f => {
                const option = document.createElement("option");
                option.value = f;
                option.textContent = f.toUpperCase();
                select.appendChild(option);
            });

            li.appendChild(btn);
            li.appendChild(select);
        }

        // Show download and related videos for completed transcoding
        if (video.status === "completed") {
            const downloadBtn = document.createElement("button");
            downloadBtn.textContent = "Download";
            downloadBtn.onclick = async () => {
                try {
                    // Get pre-signed URL from server
                    const res = await fetch(`/download/${video.id}`, {
                        headers: { "Authorization": `Bearer ${token}` }
                    });

                    if (!res.ok) {
                        alert("Download failed: " + res.statusText);
                        return;
                    }

                    const data = await res.json();

                    // Open pre-signed URL in new tab (S3 will handle the download)
                    window.open(data.downloadUrl, '_blank');

                } catch (error) {
                    console.error('Download error:', error);
                    alert("Download failed: " + error.message);
                }
            };
            li.appendChild(downloadBtn);

            // Related videos container
            const relatedDiv = document.createElement("div");
            relatedDiv.className = "related-videos";
            li.appendChild(relatedDiv);

            // Fetch related videos
            fetchRelatedVideos(video.originalName, relatedDiv);
        }

        // Show status for processing videos
        if (video.status === "processing") {
            const statusSpan = document.createElement("span");
            statusSpan.textContent = " (Processing...)";
            statusSpan.className = "processing-status";
            li.appendChild(statusSpan);
        }

        // Show error status
        if (video.status === "error") {
            const errorSpan = document.createElement("span");
            errorSpan.textContent = " (Error occurred)";
            errorSpan.className = "error-status";
            errorSpan.style.color = "red";
            li.appendChild(errorSpan);
        }

        list.appendChild(li);
    });
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

        // Start polling for status updates
        const checkStatus = async () => {
            try {
                const statusRes = await fetch(`/videos/${id}/status`, {
                    headers: { "Authorization": `Bearer ${token}` }
                });

                if (!statusRes.ok) throw new Error('Status check failed');

                const statusData = await statusRes.json();

                // Handle different status outcomes
                if (statusData.status === 'completed') {
                    alert('Transcoding finished successfully!');
                    fetchVideos(); // Refresh the entire list
                } else if (statusData.status === 'error') {
                    alert('Transcoding failed. Please try again.');
                    fetchVideos(); // Refresh to show error status
                } else if (statusData.status === 'processing') {
                    // If still processing, check again in 5 seconds
                    setTimeout(checkStatus, 5000);
                }
            } catch (error) {
                console.error("Status check error:", error);
                // Stop polling on error, but don't alert - video might still be processing
            }
        };

        // Start polling after a short delay
        setTimeout(checkStatus, 3000);

    } catch (error) {
        console.error("Transcoding error:", error);
        alert('Error starting transcoding: ' + error.message);
    }
}