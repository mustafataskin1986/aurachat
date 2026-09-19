import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import {
    initializeFirestore,
    persistentLocalCache,
    persistentSingleTabManager
} from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";

const firebaseConfig = {
    apiKey: "AIzaSyDTOmajjZsfnikrJLM1UVmXMlUobFNyJGs",
    authDomain: "aurachat-99f69.firebaseapp.com",
    projectId: "aurachat-99f69",
    storageBucket: "aurachat-99f69.firebasestorage.app",
    messagingSenderId: "447747395966",
    appId: "1:447747395966:web:7db71f9f912a188d17632f"
};

export const app = initializeApp(firebaseConfig);

// Kalıcı yerel önbellek: bir sohbeti bir kez açtıktan sonra, tekrar
// girişlerde Firestore önce yerel diskten (IndexedDB) anında gösterir,
// arka planda sessizce sunucuyla senkronize eder - network beklemesi olmaz.
export const db = initializeFirestore(app, {
    experimentalAutoDetectLongPolling: true,
    localCache: persistentLocalCache({
        tabManager: persistentSingleTabManager({})
    })
});

export const auth = getAuth(app);

auth.languageCode = 'tr';

// Admin gmail adresi tek yerden yönetilsin diye burada
export const ADMIN_EMAIL = "mustafataskin1986@gmail.com";