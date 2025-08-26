let token = null;

// Login form
const loginForm = document.getElementById('loginForm');
if (loginForm) {
    loginForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const username = document.getElementById('username').value;
        const password = document.getElementById('password').value;

        const res = await fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ username, password })
        });

        if (res.ok) {
            const data = await res.json();
            token = data.token;
            alert('Logged in successfully!');
            window.location.href = 'dashboard.html';
        } else {
            alert('Login failed');
        }
    });
}

// Upload form
const uploadForm = document.getElementById('uploadForm');
if (uploadForm) {
    uploadForm.addEventListener('submit', async (e) => {
        e.preventDefault();
        const fileInput = document.getElementById('videoFile');
        const formData = new FormData();
        formData.append('video', fileInput.files[0]);

        const res = await fetch('/upload', {
            method: 'POST',
            headers: { 'Authorization': 'Bearer ' + token },
            body: formData
        });

        if (res.ok) {
            alert('Upload successful!');
            loadVideos();
        } else {
            alert('Upload failed');
        }
    });
}

// List user videos
async function loadVideos() {
    const res = await fetch('/videos', {
        headers: { 'Authorization': 'Bearer ' + token }
    });
    const videos = await res.json();
    const list = document.getElementById('videoList');
    list.innerHTML = '';
    videos.forEach(v => {
        const li = document.createElement('li');
        li.innerHTML = `${v.originalName} - <a href="/download/${v.id}">Download</a>`;
        list.appendChild(li);
    });
}

// Load videos on dashboard
if (document.getElementById('videoList')) {
    loadVideos();
}
