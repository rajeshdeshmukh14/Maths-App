# Rajesh Maths Tutor — login app

Students log in with a username and password you create. Each student sees only their own board and class. The server enforces this, not the browser.

## What it does
- **Login:** teacher (admin) and student accounts, passwords stored hashed, 7-day sessions, 5 wrong attempts locks login for 15 minutes.
- **Admin panel:** enroll students directly (name, username, password, board, class, plan), switch free/paid, reset password, disable, delete. Add/delete videos. Set the live class link.
- **Students:** quiz (their class), AI doubt-solver, videos, live class link, change password.
- **Free vs paid:** free students see free videos only; paid videos and the live link are paid-only.
- **Boards:** CBSE, ICSE, State board, IGCSE / other.

## Run it on your computer
1. Install Node.js 18 or newer.
2. In this folder run: `npm install`
3. First run, set your teacher login (choose your own):
   - Mac/Linux: `ADMIN_USER=rajesh ADMIN_PASS=ChooseAStrongPass1 npm start`
   - Windows (PowerShell): `$env:ADMIN_USER="rajesh"; $env:ADMIN_PASS="ChooseAStrongPass1"; npm start`
4. Open http://localhost:3000 and log in as the teacher.

After the first run the admin account is saved, and you only need `npm start`.

## Optional: AI doubt-solver
Set `ANTHROPIC_API_KEY` (from the Anthropic Console). Each student gets 20 doubts a day (`DOUBTS_PER_DAY` to change). The key stays on the server. Usage is billed to your API account.

## Put it online (so students can reach it)
Use any Node host with HTTPS, for example Render, Railway or Fly.io.
- Start command: `npm start`. Set `NODE_ENV=production`, `ADMIN_USER`, `ADMIN_PASS` (and optionally `ANTHROPIC_API_KEY`).
- The database is the file `data.db`. Your host **must keep a persistent disk** for it (set `DB_PATH` to a path on that disk), or all students will be lost on restart.
- **Back up `data.db` regularly.**

## Important notes
- This was written but **not run or security-tested here**. Test with a few accounts before real students use it, and ideally have a developer review it before you rely on it.
- Your students are minors. You are responsible for their data and for following the privacy laws that apply to you. Collect only what you need (name and username) and keep admin access to yourself.
- Quiz answers are sent to the browser for instant feedback, so a determined student could see them in developer tools. This is fine for practice, not for graded tests.
- Login throttling resets when the server restarts. There is no email password reset: ask the teacher to reset it.
- Quiz questions live in `questions.json` (grade, topic, question, options, correct option number, explanation). Edit or extend it freely.
