logoutBtn.addEventListener('click', () => {
    localStorage.removeItem('aurachat_user');
    localStorage.removeItem('aurachat_contacts_cache');
    location.reload();
});
