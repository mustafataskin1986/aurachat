// ==========================================
// AURA DİYALOG (WhatsApp tarzı onay penceresi)
// Tarayıcının confirm() penceresi yerine kullanılır.
// auraDialog({ title, buttons:[{id,label}], checkbox:{label}|null })
//   -> Promise<{ id: basılan düğmenin id'si ('cancel' = geri/boşluk), checked: kutucuk durumu }>
// accent: düğme/kutucuk rengi (verilmezse yeşil). Sohbet içinde auraAccent() ile tema rengi verilir.
// 3 veya daha çok düğmede düğmeler alt alta, 2 düğmede yan yana dizilir.
// ==========================================
import { pushBackState, popBackState } from "./back-handler.js";

// Açık sohbetin tema rengi (yoksa varsayılan yeşil)
export function auraAccent() {
    try {
        const v = getComputedStyle(document.documentElement).getPropertyValue('--aura-btn').trim();
        return v || '#22c55e';
    } catch (e) {
        return '#22c55e';
    }
}

export function auraDialog(opts) {
    const title = (opts && opts.title) || '';
    const buttons = (opts && opts.buttons) || [{ id: 'cancel', label: 'İptal' }];
    const checkbox = (opts && opts.checkbox) || null;
    const accent = (opts && opts.accent) || '#22c55e';

    return new Promise((resolve) => {
        const black = document.documentElement.hasAttribute('data-aura-black');
        const overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;inset:0;z-index:300;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(0,0,0,.6);';

        const box = document.createElement('div');
        box.style.cssText = 'width:100%;max-width:360px;border-radius:28px;padding:28px 24px 16px;box-shadow:0 10px 40px rgba(0,0,0,.6);'
            + 'background:' + (black ? '#000' : '#111b21') + ';border:1px solid rgba(255,255,255,.08);';

        const h = document.createElement('div');
        h.textContent = title;
        h.style.cssText = 'color:#e9edef;font-size:20px;line-height:1.3;margin:0 4px 20px;';
        box.appendChild(h);

        let cb = null;
        if (checkbox) {
            const row = document.createElement('label');
            row.style.cssText = 'display:flex;align-items:center;gap:14px;margin:0 4px 20px;color:#e9edef;font-size:16px;cursor:pointer;';
            cb = document.createElement('input');
            cb.type = 'checkbox';
            cb.style.cssText = 'width:22px;height:22px;flex:none;accent-color:' + accent + ';';
            const t = document.createElement('span');
            t.textContent = checkbox.label || '';
            row.appendChild(cb);
            row.appendChild(t);
            box.appendChild(row);
        }

        const stacked = buttons.length > 2;
        const btnRow = document.createElement('div');
        btnRow.style.cssText = stacked
            ? 'display:flex;flex-direction:column;align-items:flex-end;'
            : 'display:flex;justify-content:flex-end;gap:8px;';

        let done = false;
        const finish = (id, fromBack) => {
            if (done) return;
            done = true;
            overlay.remove();
            if (!fromBack) popBackState();
            resolve({ id: id, checked: cb ? cb.checked : false });
        };

        buttons.forEach((b) => {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = b.label;
            btn.style.cssText = 'background:none;border:0;color:' + accent + ';font-size:17px;padding:12px 14px;cursor:pointer;';
            btn.addEventListener('click', () => finish(b.id, false));
            btnRow.appendChild(btn);
        });
        box.appendChild(btnRow);

        overlay.appendChild(box);
        overlay.addEventListener('click', (e) => { if (e.target === overlay) finish('cancel', false); });
        document.body.appendChild(overlay);
        pushBackState(() => finish('cancel', true));
    });
}
