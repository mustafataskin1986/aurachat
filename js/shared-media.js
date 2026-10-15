// ==========================================
// TÜM MEDYALAR: sohbette paylaşılan Medya / Belgeler / Bağlantılar
// Kişi bilgisi sayfasındaki "Medya, bağlantılar ve belgeler" satırından açılır.
// ==========================================

import { getChatMedia, getChatMediaThumb, openChatMediaImage, openChatDocument, openChatLink } from "./chat-core.js";
import { escapeHtml } from "./ui-helpers.js";
import { pushBackState, popBackState } from "./back-handler.js";

let el = null;
let open = false;
let curChatId = null;
let curTab = 'media';
let observer = null;

const MONTHS = ['Ocak', 'Şubat', 'Mart', 'Nisan', 'Mayıs', 'Haziran', 'Temmuz', 'Ağustos', 'Eylül', 'Ekim', 'Kasım', 'Aralık'];

export function mediaCounts(chatId) {
    const m = getChatMedia(chatId);
    return { media: m.images.length, docs: m.docs.length, links: m.links.length, total: m.images.length + m.docs.length + m.links.length };
}

function groupLabel(ms) {
    const d = new Date(ms), now = new Date();
    const diff = (now.getFullYear() - d.getFullYear()) * 12 + (now.getMonth() - d.getMonth());
    if (diff === 0) return 'BU AY';
    if (diff === 1) return 'GEÇEN AY';
    const name = MONTHS[d.getMonth()].toLocaleUpperCase('tr-TR');
    return d.getFullYear() === now.getFullYear() ? name : name + ' ' + d.getFullYear();
}

function dateText(ms) {
    const d = new Date(ms);
    return d.getDate() + ' ' + MONTHS[d.getMonth()] + ' ' + d.getFullYear();
}

// Kişi / grup bilgisi sayfalarındaki "Medya, bağlantı ve belgeler" satırı (başlık + sayı + son 5 resim)
export function mediaBlockHtml(id) {
    return `<div data-row="media" id="${id}" class="w-full px-5 pt-4 pb-3 active:bg-white/5 transition" style="cursor:pointer;">
        <div class="flex items-center">
            <span class="flex-1 min-w-0 text-white text-[16px]">Medya, bağlantı ve belgeler</span>
            <span class="sm-count text-gray-400 text-[15px] mr-3">0</span>
            <i class="fa-solid fa-chevron-right text-gray-400 text-sm"></i>
        </div>
        <div class="sm-strip" style="gap:8px;margin-top:12px;overflow:hidden;display:none;"></div>
    </div>`;
}

export function refreshMediaBlock(block, chatId) {
    if (!block || !chatId) return;
    const put = () => {
        if (!block.isConnected) return;
        const data = getChatMedia(chatId);
        block.querySelector('.sm-count').textContent = String(data.images.length + data.docs.length + data.links.length);
        const strip = block.querySelector('.sm-strip');
        const imgs = data.images.slice(0, 5);
        const key = chatId + '|' + imgs.map((i) => i.msgId + ':' + i.idx).join(',');
        if (strip.dataset.key === key) return;
        strip.dataset.key = key;
        strip.innerHTML = '';
        strip.style.display = imgs.length ? 'flex' : 'none';
        imgs.forEach((it) => {
            const box = document.createElement('div');
            box.style.cssText = 'width:84px;height:84px;border-radius:12px;background:#1f2c33;overflow:hidden;flex-shrink:0;';
            strip.appendChild(box);
            getChatMediaThumb(chatId, it.msgId, it.idx).then((src) => {
                if (!src || !box.isConnected) return;
                const im = document.createElement('img');
                im.src = src;
                im.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
                box.appendChild(im);
            });
        });
    };
    put();
    setTimeout(put, 800);
    setTimeout(put, 2500);
}

// "Sohbette göster" seçilince bu sayfa kapanıp sohbet görünsün
window.addEventListener('aura-show-in-chat', () => { if (open) close(); });

function closeFromBack() {
    if (observer) { observer.disconnect(); observer = null; }
    if (el) { el.remove(); el = null; }
    open = false;
}
function close() { if (!open) return; closeFromBack(); popBackState(); }

function emptyHtml(t) {
    return `<div class="text-gray-500 text-center" style="padding:60px 24px;font-size:15px;">${t}</div>`;
}

function renderMedia(body, data) {
    if (!data.images.length) { body.innerHTML = emptyHtml('Paylaşılan medya yok'); return; }
    let html = '', last = '';
    data.images.forEach((it, i) => {
        const g = groupLabel(it.time);
        if (g !== last) {
            if (last) html += '</div>';
            html += `<div class="px-4 py-3 text-gray-400" style="font-size:15px;letter-spacing:.3px;">${g}</div><div style="display:grid;grid-template-columns:repeat(3,1fr);gap:2px;">`;
            last = g;
        }
        html += `<button type="button" data-i="${i}" class="sm-cell" style="position:relative;aspect-ratio:1/1;background:#1f2c33;overflow:hidden;padding:0;">
            ${it.starred ? '<i class="fa-solid fa-star" style="position:absolute;right:8px;bottom:6px;color:#fff;font-size:18px;z-index:2;filter:drop-shadow(0 1px 2px rgba(0,0,0,.6));"></i>' : ''}
        </button>`;
    });
    html += '</div><div style="height:30px"></div>';
    body.innerHTML = html;

    observer = new IntersectionObserver((entries) => {
        entries.forEach(async (en) => {
            if (!en.isIntersecting) return;
            const cell = en.target;
            observer.unobserve(cell);
            const it = data.images[+cell.dataset.i];
            const src = await getChatMediaThumb(curChatId, it.msgId, it.idx);
            if (!src || !cell.isConnected) return;
            const img = document.createElement('img');
            img.decoding = 'async';
            img.src = src;
            img.style.cssText = 'width:100%;height:100%;object-fit:cover;display:block;';
            cell.insertBefore(img, cell.firstChild);
        });
    }, { root: body, rootMargin: '300px' });
    body.querySelectorAll('.sm-cell').forEach((c) => observer.observe(c));
    body.onclick = (e) => {
        const c = e.target.closest('.sm-cell');
        if (!c) return;
        const it = data.images[+c.dataset.i];
        openChatMediaImage(curChatId, it.msgId, it.idx, it.count);
    };
}

function docIcon(name) {
    const ext = (String(name).split('.').pop() || '').toLowerCase();
    if (ext === 'pdf') return ['fa-file-pdf', '#ef4444'];
    if (['doc', 'docx'].includes(ext)) return ['fa-file-word', '#3b82f6'];
    if (['xls', 'xlsx', 'csv'].includes(ext)) return ['fa-file-excel', '#22c55e'];
    if (['ppt', 'pptx'].includes(ext)) return ['fa-file-powerpoint', '#f97316'];
    if (['zip', 'rar', '7z'].includes(ext)) return ['fa-file-zipper', '#eab308'];
    return ['fa-file', '#9ca3af'];
}

function renderDocs(body, data) {
    if (!data.docs.length) { body.innerHTML = emptyHtml('Paylaşılan belge yok'); return; }
    body.innerHTML = data.docs.map((d, i) => {
        const [ic, col] = docIcon(d.name);
        return `<button type="button" data-i="${i}" class="w-full flex items-center text-left active:bg-white/5" style="padding:12px 16px;gap:14px;">
            <span style="width:44px;height:44px;border-radius:10px;background:#1f2c33;display:flex;align-items:center;justify-content:center;flex-shrink:0;"><i class="fa-solid ${ic}" style="color:${col};font-size:20px;"></i></span>
            <span class="min-w-0 flex-1"><span class="block text-white" style="font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(d.name)}</span>
            <span class="block text-gray-400" style="font-size:13px;margin-top:2px;">${dateText(d.time)}</span></span></button>`;
    }).join('');
    body.onclick = (e) => {
        const b = e.target.closest('button[data-i]');
        if (b) openChatDocument(curChatId, data.docs[+b.dataset.i].msgId);
    };
}

function renderLinks(body, data) {
    if (!data.links.length) { body.innerHTML = emptyHtml('Paylaşılan bağlantı yok'); return; }
    body.innerHTML = data.links.map((l, i) => {
        let host = l.url;
        try { host = new URL(l.url).hostname.replace(/^www\./, ''); } catch (e) {}
        return `<button type="button" data-i="${i}" class="w-full flex items-center text-left active:bg-white/5" style="padding:12px 16px;gap:14px;">
            <span style="width:44px;height:44px;border-radius:10px;background:#1f2c33;display:flex;align-items:center;justify-content:center;flex-shrink:0;"><i class="fa-solid fa-link" style="color:#7dd3fc;font-size:18px;"></i></span>
            <span class="min-w-0 flex-1"><span class="block text-white" style="font-size:16px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(l.title || host)}</span>
            <span class="block" style="font-size:13px;color:#7dd3fc;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-top:2px;">${escapeHtml(l.url)}</span>
            <span class="block text-gray-500" style="font-size:12px;margin-top:2px;">${dateText(l.time)}</span></span></button>`;
    }).join('');
    body.onclick = (e) => {
        const b = e.target.closest('button[data-i]');
        if (b) openChatLink(data.links[+b.dataset.i].url);
    };
}

function renderTab() {
    if (!el) return;
    if (observer) { observer.disconnect(); observer = null; }
    const data = getChatMedia(curChatId);
    const body = el.querySelector('#sm-body');
    body.scrollTop = 0;
    el.querySelectorAll('[data-tab]').forEach((t) => {
        const on = t.dataset.tab === curTab;
        t.style.color = on ? '#22c55e' : '#9ca3af';
        t.style.borderBottom = on ? '3px solid #22c55e' : '3px solid transparent';
    });
    if (curTab === 'media') renderMedia(body, data);
    else if (curTab === 'docs') renderDocs(body, data);
    else renderLinks(body, data);
}

export function openSharedMedia(chatId, tab) {
    if (open) return;
    curChatId = chatId;
    curTab = tab || 'media';
    el = document.createElement('div');
    el.style.cssText = 'position:fixed;inset:0;z-index:72;background:#0b141a;display:flex;flex-direction:column;';
    el.innerHTML = `
        <div style="display:flex;align-items:center;gap:20px;padding:0 16px;height:64px;flex-shrink:0;">
            <button type="button" id="sm-back" style="color:#fff;font-size:20px;padding:4px;"><i class="fa-solid fa-arrow-left"></i></button>
            <span style="color:#fff;font-size:22px;">Tüm medyalar</span>
        </div>
        <div style="display:flex;flex-shrink:0;border-bottom:1px solid rgba(255,255,255,.08);">
            <button type="button" data-tab="media" style="flex:1;padding:14px 0;font-size:18px;">Medya</button>
            <button type="button" data-tab="docs" style="flex:1;padding:14px 0;font-size:18px;">Belgeler</button>
            <button type="button" data-tab="links" style="flex:1;padding:14px 0;font-size:18px;">Bağlantılar</button>
        </div>
        <div id="sm-body" style="flex:1;overflow-y:auto;"></div>`;
    document.body.appendChild(el);
    el.querySelector('#sm-back').addEventListener('click', close);
    el.querySelectorAll('[data-tab]').forEach((t) => t.addEventListener('click', () => { curTab = t.dataset.tab; renderTab(); }));
    open = true;
    pushBackState(closeFromBack);
    renderTab();
}
