// Selfie check-in: live front camera → small JPEG, plus GPS if allowed.
// Falls back to the phone's own camera picker when live camera access is unavailable.
(function () {
  const form = document.getElementById('checkin-form')
  if (!form) return
  const video = document.getElementById('cam')
  const canvas = document.getElementById('shot')
  const preview = document.getElementById('preview')
  const msg = document.getElementById('cam-msg')
  const snap = document.getElementById('snap')
  const retake = document.getElementById('retake')
  const send = document.getElementById('send')
  const fileInput = document.getElementById('photo-file')
  let stream = null
  let blob = null

  // Location (optional): recorded with the check-in for the Principal.
  if (navigator.geolocation) {
    navigator.geolocation.getCurrentPosition((p) => {
      document.getElementById('lat').value = p.coords.latitude
      document.getElementById('lng').value = p.coords.longitude
      document.getElementById('accuracy').value = Math.round(p.coords.accuracy)
    }, () => {}, { enableHighAccuracy: true, timeout: 15000, maximumAge: 60000 })
  }

  function useFallback(reason) {
    msg.textContent = reason + ' Tap "Take selfie" to open your camera.'
    video.hidden = true
    snap.onclick = () => fileInput.click()
    fileInput.onchange = async () => {
      const f = fileInput.files && fileInput.files[0]
      if (!f) return
      blob = await shrink(await loadImage(URL.createObjectURL(f)))
      showPreview()
    }
  }

  function loadImage(src) {
    return new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src })
  }

  function shrink(source) {
    const w = source.videoWidth || source.naturalWidth
    const h = source.videoHeight || source.naturalHeight
    const scale = Math.min(1, 480 / Math.max(w, h))
    canvas.width = Math.round(w * scale)
    canvas.height = Math.round(h * scale)
    canvas.getContext('2d').drawImage(source, 0, 0, canvas.width, canvas.height)
    return new Promise((res) => canvas.toBlob(res, 'image/jpeg', 0.75))
  }

  function showPreview() {
    preview.src = URL.createObjectURL(blob)
    preview.hidden = false
    video.hidden = true
    snap.hidden = true
    retake.hidden = false
    send.hidden = false
    msg.textContent = 'Happy with it? Tap Check in.'
  }

  retake.onclick = () => {
    blob = null
    preview.hidden = true
    if (stream) video.hidden = false
    snap.hidden = false
    retake.hidden = true
    send.hidden = true
    msg.textContent = 'Look at the camera and tap Take selfie.'
  }

  if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
    navigator.mediaDevices.getUserMedia({ video: { facingMode: 'user', width: { ideal: 640 } }, audio: false })
      .then((s) => {
        stream = s
        video.srcObject = s
        snap.onclick = async () => { blob = await shrink(video); showPreview() }
      })
      .catch(() => useFallback('Live camera is not available.'))
  } else {
    useFallback('Live camera is not supported here.')
  }

  form.addEventListener('submit', async (e) => {
    if (!blob) { e.preventDefault(); msg.textContent = 'Please take a selfie first.'; return }
    e.preventDefault()
    send.disabled = true
    send.textContent = 'Saving…'
    const data = new FormData(form)
    data.set('photo', blob, 'selfie.jpg')
    try {
      const res = await fetch(form.action, { method: 'POST', body: data, credentials: 'same-origin' })
      if (stream) stream.getTracks().forEach((t) => t.stop())
      location.href = res.url || form.action
    } catch {
      send.disabled = false
      send.textContent = 'Check in'
      msg.textContent = 'Could not upload. Check your internet connection and try again.'
    }
  })
})()
