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

    const formData = new FormData();
    formData.append("video", file);

    const res = await fetch("/upload", {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}` },
        body: formData
    });

    const data = await res.json();
    document.getElementById("uploadMessage").textContent = res.ok ? "Upload successful!" : data.error;
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

        // Change "transcoded" to "completed" here
        if (video.status === "completed") {
            const downloadBtn = document.createElement("button");
            downloadBtn.textContent = "Download";
            downloadBtn.onclick = async () => {
                const res = await fetch(`/download/${video.id}`, {
                    headers: { "Authorization": `Bearer ${token}` }
                });
                if (!res.ok) {
                    alert("Download failed: " + res.statusText);
                    return;
                }
                const blob = await res.blob();
                const url = window.URL.createObjectURL(blob);
                const a = document.createElement("a");
                a.href = url;

                // Fix this condition too - change to "completed"
                if (video.status === "completed") {
                    // extract filename from outputPath (from back-end)
                    a.download = video.outputPath.split("/").pop();
                } else {
                    a.download = video.originalName;
                }

                document.body.appendChild(a);
                a.click();
                a.remove();
                window.URL.revokeObjectURL(url);
            };
            li.appendChild(downloadBtn);

            // Related videos container
            const relatedDiv = document.createElement("div");
            relatedDiv.className = "related-videos";
            li.appendChild(relatedDiv);

            // Fetch related videos
            fetchRelatedVideos(video.originalName, relatedDiv);
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

        // Get the video list item element to update its status
        const videoItem = document.querySelector(`li:has(button[onclick*="${id}"])`);
        const statusElement = videoItem ? videoItem.querySelector('.status') || document.createElement('span') : null;
        if (statusElement && !statusElement.classList.contains('status')) {
            statusElement.className = 'status';
            videoItem.appendChild(statusElement);
        }

        // Function to poll for status updates
        const checkStatus = async () => {
            try {
                const statusRes = await fetch(`/videos/${id}/status`, {
                    headers: { "Authorization": `Bearer ${token}` }
                });

                if (!statusRes.ok) throw new Error('Status check failed');

                const statusData = await statusRes.json();

                // Update the UI with the current status
                if (statusElement) {
                    statusElement.textContent = `Status: ${statusData.status}`;
                }

                // Handle different status outcomes
                if (statusData.status === 'completed') {
                    alert('Transcoding finished successfully!');
                    fetchVideos(); // Refresh the entire list
                } else if (statusData.status === 'error') {
                    alert('Transcoding failed. Please try again.');
                } else if (statusData.status === 'processing') {
                    // If still processing, check again in 3 seconds
                    setTimeout(checkStatus, 3000);
                }
            } catch (error) {
                console.error("Status check error:", error);
                if (statusElement) {
                    statusElement.textContent = 'Status: check failed';
                }
            }
        };

        // Start pollinåçg
        checkStatus();

    } catch (error) {
        console.error("Transcoding error:", error);
        alert('Error starting transcoding: ' + error.message);
    }
}
