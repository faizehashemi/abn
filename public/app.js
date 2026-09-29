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

  // Close the mobile menu after choosing a link.
  const toggle = document.getElementById('nav-toggle')
  document.querySelectorAll('.sidenav a').forEach((a) => a.addEventListener('click', () => { if (toggle) toggle.checked = false }))
})
