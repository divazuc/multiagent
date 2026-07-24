# הקשחת Cloudflare Access — wastudio.divdev.co

מדריך חד-פעמי (≈10 דק'). המטרה: כניסה ל-Studio ול-/demo רק אחרי אימות אימייל+קוד (One-time PIN),
בלי לחסום את פורטל הלקוחות שיש לו לוגין משלו.

> **חשוב — מה לא מקשיחים ב-Access:** את `wagent.divdev.co` (ה-API) **לא** מכניסים ל-Access —
> זה ישבור את פורטל הלקוחות ואת ה-webhook של Meta. ה-API כבר מוגן ברמת אפליקציה
> (מפתח אדמין + טוקני פורטל + חתימת Meta).

## שלב 1 — אפליקציית Bypass לפורטל (קודם!)

Zero Trust → Access → Applications → Add an application → **Self-hosted**

- **Name**: `WA Portal bypass`
- **Public hostnames** — להוסיף את כולם לאותה אפליקציה:
  - `wastudio.divdev.co` path `portal`
  - `wastudio.divdev.co` path `portal.html`
  - `wastudio.divdev.co` path `assets/*`  ← בלי זה ה-JS/CSS של הפורטל ייחסם ללקוחות!
  - `wastudio.divdev.co` path `vite.svg` (אייקון)
- **Policy**: Action **Bypass**, Include → **Everyone**

## שלב 2 — אפליקציית ההגנה הראשית

Add an application → **Self-hosted**

- **Name**: `WA Studio (operator)`
- **Public hostname**: `wastudio.divdev.co` (path ריק — תופס הכל, כולל /demo)
- **Policy**: Action **Allow**, Include → **Emails** → `divazuc@gmail.com`
- **Login methods**: One-time PIN בלבד
- **Session duration**: 1 שבוע (או לפי נוחות)

## שלב 3 — בדיקה

1. חלון גלישה בסתר → `https://wastudio.divdev.co` → אמור לבקש אימייל+קוד; אחרי אימות — מסך הלוגין של הסטודיו (סיסמת מנהל)
2. חלון בסתר → `https://wastudio.divdev.co/portal` → אמור להיפתח **בלי** Access, ישר למסך הלוגין של הלקוחות
3. `https://wastudio.divdev.co/demo` → מאחורי Access + סיסמת מנהל

## סדר השכבות אחרי ההקשחה

| משטח | שכבה 1 | שכבה 2 |
|------|--------|--------|
| Studio `/` | CF Access (אימייל+קוד) | סיסמת מנהל (ADMIN_API_KEY) |
| `/demo` | CF Access | סיסמת מנהל |
| `/portal` | — (Bypass) | לוגין לקוח (אימייל+סיסמה, טוקן חתום) |
| API `wagent.divdev.co` | — | מפתח אדמין / טוקן פורטל / חתימת Meta |
