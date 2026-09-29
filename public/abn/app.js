// Small progressive enhancements. Every page works without JavaScript.
document.addEventListener('DOMContentLoaded', () => {
  // Confirmation prompts on destructive forms: <form data-confirm="…">
  document.querySelectorAll('form[data-confirm]').forEach((form) => {
    form.addEventListener('submit', (e) => {
      if (!confirm(form.dataset.confirm)) e.preventDefault()
    })
  })

  // Attendance: "All Present / All Absent / Clear"
  document.querySelectorAll('[data-mark-all]').forEach((btn) => {
    btn.addEventListener('click', () => {
      const value = btn.dataset.markAll
      const form = btn.closest('form')
      form.querySelectorAll(`input[type=radio][value="${value}"]`).forEach((r) => { r.checked = true })
    })
  })

  // Announcement pop-up: open as a true modal when supported.
  const modal = document.getElementById('announcement-modal')
  if (modal && typeof modal.showModal === 'function') {
    modal.removeAttribute('open')
    modal.showModal()
    modal.addEventListener('cancel', (e) => e.preventDefault()) // must acknowledge
  }

  // Profile photo: shrink to max 480px JPEG in the browser before upload,
  // so a 5 MB phone photo becomes ~50 KB (photos are stored in the database).
  document.querySelectorAll('input[type=file][name=photo]').forEach((input) => {
    input.addEventListener('change', async () => {
      const file = input.files && input.files[0]
      if (!file || !file.type.startsWith('image/') || typeof DataTransfer === 'undefined') return
      try {
        const img = await new Promise((resolve, reject) => {
          const i = new Image()
          i.onload = () => resolve(i)
          i.onerror = reject
          i.src = URL.createObjectURL(file)
        })
        const scale = Math.min(1, 480 / Math.max(img.naturalWidth, img.naturalHeight))
        const canvas = document.createElement('canvas')
        canvas.width = Math.round(img.naturalWidth * scale)
        canvas.height = Math.round(img.naturalHeight * scale)
        canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height)
        const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85))
        if (!blob) return
        const dt = new DataTransfer()
        dt.items.add(new File([blob], 'photo.jpg', { type: 'image/jpeg' }))
        input.files = dt.files
        const preview = input.closest('.photo-row') && input.closest('.photo-row').querySelector('.avatar')
        if (preview && preview.tagName === 'IMG') preview.src = URL.createObjectURL(blob)
      } catch (e) { /* keep the original file; the server will validate it */ }
    })
  })

  // Close the mobile menu after choosing a link.
  const toggle = document.getElementById('nav-toggle')
  document.querySelectorAll('.sidenav a').forEach((a) => a.addEventListener('click', () => { if (toggle) toggle.checked = false }))
})
