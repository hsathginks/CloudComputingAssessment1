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

// Fetch videos
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
            // Create format selector
            const select = document.createElement("select");
            ["mp4", "mp3", "avi", "mov"].forEach(f => {
                const option = document.createElement("option");
                option.value = f;
                option.textContent = f.toUpperCase();
                select.appendChild(option);
            });

            // Transcode button
            const btn = document.createElement("button");
            btn.textContent = "Transcode";
            btn.onclick = () => transcodeVideo(video.id, select.value);

            li.appendChild(select);
            li.appendChild(btn);
        }

        if (video.status === "transcoded") {
            const download = document.createElement("a");
            download.href = `/download/${video.id}`;
            download.textContent = "Download";
            download.setAttribute("target", "_blank");
            li.appendChild(download);
        }

        list.appendChild(li);
    });
}

// Transcode video
async function transcodeVideo(id, format) {
    const res = await fetch("/transcode", {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
            "Authorization": `Bearer ${token}`
        },
        body: JSON.stringify({ id, format })
    });

    const data = await res.json();
    alert(res.ok ? "Transcoding started" : data.error);
    fetchVideos();
}
