# Fixes verification — weekly video screens (Nov 2–6, 2026 week)
Verified: 2026-11-09 ~12:25 UTC. Public sources only; no invented numbers.

---

## 1. Nifty 50 / Sensex weekly change (week ending Fri Nov 6, 2026)

### Correct week figure
| Index | Prior-week Fri close (Oct 30) | Week-end Fri close (Nov 6) | Points | % |
|---|---|---|---|---|
| Nifty 50 | **23,053.10** | **25,030.35** | +1,977.25 | **+8.58%** (8.5769%; Moneycontrol rounds to 8.57%) |
| Sensex | **74,459.53** | **81,028.02** | +6,568.49 | **+8.82%** |

**Exact date window:** Fri Oct 30, 2026 close → Fri Nov 6, 2026 close (standard prior-week last close → this-week Friday close). Trading sessions in the week: Mon Nov 2, Tue Nov 3, Wed Nov 4, Thu Nov 5, Fri Nov 6.

**Script (~+8.6% / +8.8%):** Correct. Matches Reuters’ “about 8.6% and 8.8%” wording and Moneycontrol’s 8.57% / 8.82%.

### Why Google Finance 5D showed +5.59% / +4.84% (viewed Nov 9)
Google Finance “5D” is a **rolling last-five-sessions** window as of the view date, **not** the Mon–Fri calendar week ending Nov 6. Viewed Mon Nov 9 it spans sessions around Nov 3–9 (and can include Diwali Muhurat on Sun Nov 8), so it **excludes** Mon Nov 2’s large gain and **includes** post-week sessions. That is why the % is smaller than the week figure. Do **not** use a live 5D chart to illustrate the VO’s weekly numbers.

### Muhurat (Sun Nov 8) and the weekly figure
- Muhurat special session: **Sun Nov 8, 2026** (after the Fri Nov 6 week close).
- Reported Muhurat closes (Moneycontrol): Nifty **24,986.40** (−0.18%), Sensex **80,999.40** (−0.04%).
- **Does not change** the Nov 2–6 weekly figure. Keep weekly VO on Oct 30 → Nov 6; treat Muhurat as a separate beat (line 8).

### Chart URL / range that shows the exact week window
Prefer a **custom date range** (or a weekly candle), not Google/Yahoo “5D”:

1. **TradingView (best for screenshot)**  
   - Nifty: https://www.tradingview.com/chart/?symbol=NSE%3ANIFTY  
   - Sensex: https://www.tradingview.com/chart/?symbol=BSE%3ASENSEX  
   - Set range **Oct 30, 2026 → Nov 6, 2026** (or show the weekly bar for week of Nov 2). Percent change from Oct 30 close to Nov 6 close should read ~+8.58% / +8.82%.

2. **Yahoo Finance historical tables (verify closes)**  
   - Nifty: https://finance.yahoo.com/quote/%5ENSEI/history/  
   - Sensex: https://finance.yahoo.com/quote/%5EBSESN/history/  
   - Rows confirm Oct 30 and Nov 6 closes above.

3. **NSE / BSE**  
   - NSE indices: https://www.nseindia.com/market-data/live-equity-market  
   - Or NSE archive close CSV pattern: `https://nsearchives.nseindia.com/content/indices/ind_close_all_DDMMYYYY.csv`

### Sources
- Reuters (Nov 6): https://www.reuters.com/5f374b32b07b/world/india/indian-stocks-set-pullback-after-sharp-rally-oil-slide-foreign-inflows-2026-11-06/ — “Nifty and Sensex gained 8.6% and 8.8% respectively this week”; Fri closes 25,030.35 / 81,028.02.
- Moneycontrol week wrap (Nov 7): https://www.moneycontrol.com/news/photos/business/stocks/markets-end-samvat-2082-on-a-strong-note-post-biggest-weekly-gains-in-six-years-14074029.html — Sensex +8.82% to 81,028.02; Nifty +8.57% to 25,030.35.
- Yahoo Finance ^NSEI / ^BSESN history (Oct 30 & Nov 6 rows).
- Oct 30 closes also in Business Standard / Telegraph India wrap: Sensex 74,459.53; Nifty 23,053.10.
- Muhurat: https://www.moneycontrol.com/news/business/markets/diwali-muhurat-trading-2026-sensex-nifty-end-lower-after-early-rally-experts-bullish-eye-upside-with-caution-14074937.html

### Fix for asset map (06a / 06b)
Replace 5D charts with **custom-range charts Oct 30 → Nov 6** (or weekly bars). Keep VO at ~+8.6% / +8.8% (or exact +8.58% / +8.82% if preferred).

---

## 2. SoftBank Group Q2 FY2026 earnings times

### Official page
https://group.softbank/en/event/earnings_2026q2

### Exact times on the page (JST only — page does **not** print UTC)
| Event | Listed time (JST) | UTC equivalent (JST = UTC+9) |
|---|---|---|
| **Financial Report disclosure** | **3:30 p.m. JST**, Nov 10, 2026 | **06:30 UTC**, Nov 10 |
| **Earnings Results Briefing / webcast** | **4:30 p.m. JST**, Nov 10, 2026 (scheduled) | **07:30 UTC**, Nov 10 |

Page wording: “Date and Time | 4:30 p.m. JST, November 10, 2026 (scheduled) Financial Report is scheduled to be disclosed at 3:30 p.m. JST.”

### Which is correct for what?
- **Script “06:30 UTC” is correct for the results / Financial Report release** (3:30 p.m. JST).
- **06:00 UTC is not on the page.** Neither listed event is 06:00 UTC. Likely a misconversion of 3:30 JST (or reading a clock that showed something else on a screenshot).
- If VO means the **briefing/call**, use **07:30 UTC** (4:30 p.m. JST), not 06:30.

### Fix for asset map (13a)
Keep SoftBank page screenshot. Align VO to **06:30 UTC = results disclosure**; if the line is about the briefing, change VO to **07:30 UTC**.

---

## 3. DOL Unemployment Insurance claims — Thu Nov 12, 2026

### Best official page that shows the schedule rule + exceptions
**URL:** https://oui.doleta.gov/unemploy/claims_arch.asp  

**Relevant lines on that page:**
- “Publication Schedule: The UI Weekly Claims News Release is published each week on **Thursday morning at 8:30am EST**.”
- “Exceptions to this schedule occur when a Thursday falls on a Federal Holiday. The following is a list of dates when the weekly news release will be published on a day other than Thursday:”
  - Wednesday, **November 25, 2026** — 8:30 AM EST  
  - Wednesday, November 10, 2027 — 8:30 AM EST  
  - Wednesday, November 24, 2027 — 8:30 AM EST  

**Nov 12, 2026 is NOT in the exceptions table** → it remains a normal Thursday release: **Thu Nov 12, 2026, 8:30 a.m. ET = 13:30 UTC**.

### Calendar that explicitly names Nov 12
**URL:** https://fred.stlouisfed.org/releases/calendar?rid=180&y=2026  
**Line:** “Thursday November 12, 2026” — Unemployment Insurance Weekly Claims Report (FRED lists **7:30 am** = Central Time; that is **8:30 a.m. ET / 13:30 UTC**).

Also: current release PDF always at https://www.dol.gov/ui/data.pdf (most recent embargo line when checked: Thursday, November 5, 2026 — i.e. last week’s release, not a forward calendar).

### Veterans Day (Nov 11)
- Veterans Day 2026 is **Wednesday, Nov 11**.
- DOL shifts only when **Thursday** is a federal holiday. Nov 12 is Thursday and is not shifted.
- The exception that *does* appear nearby is **Wed Nov 25, 2026** (day before Thanksgiving), which is what the bad screenshot likely showed (Nov 25 + 2027 dates) — wrong target for the VO.

### Fix for asset map (14a)
Do **not** use a crop of the exceptions-only table that highlights Nov 25 / 2027. Prefer:
1. FRED 2026 calendar scrolled to **Thursday November 12, 2026**, or  
2. `claims_arch.asp` with the “published each week on Thursday morning at 8:30am EST” sentence visible, plus a note that Nov 12 is not listed as an exception.

---

## Summary for News Producer
| Item | Verdict | Action |
|---|---|---|
| 06a/06b Nifty/Sensex | Script ~+8.6%/+8.8% **correct** for Oct 30→Nov 6. 5D charts wrong window. | New charts with range **Oct 30–Nov 6** (TradingView). Muhurat Nov 8 out of week. |
| 13a SoftBank | **06:30 UTC = Financial Report** (3:30 p.m. JST). Briefing = **07:30 UTC**. Page never says 06:00. | Keep page; match VO to disclosure vs briefing. |
| 14a DOL claims | **Thu Nov 12, 8:30 ET / 13:30 UTC** stands. Veterans Day Wed Nov 11 does not shift it. | Replace Nov 25/2027 exceptions crop with FRED Nov 12 row or claims_arch Thursday rule. |
