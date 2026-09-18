# CloudJoi Live Seat Selection — Mobile-First Design Handoff & Specifications

This directory contains the production-ready high-resolution (Retina 2x) Neubrutalism UI mockups and design system specifications for the CloudJoi live 4,600-seat selection project.

---

## 📱 Deliverable Screenshot Mockups

| File | Resolution | Specification & Engineering Decisions |
| :--- | :--- | :--- |
| [**`01_mobile_overview_zoom.png`**](./01_mobile_overview_zoom.png) | 390 × 844 | **Mobile Overview Zoom**: Rendered as 9 solid section polygon blocks (scale $< 0.45$). Cleaned header with redundant venue seat count box removed. Full 6-tier price legend. Availability chips updated to compliance rules: **"Only 24 left"** (Mezz L), **"Only 18 left"** (Mezz C), **"Only 19 left"** (Mezz R), and **"Sold Out"** (Balc L). |
| [**`02_mobile_close_zoom_selection.png`**](./02_mobile_close_zoom_selection.png) | 390 × 844 | **Mobile Close Zoom & Selection**: Finger-friendly **28px squircle seats inside 32px canvas hit-test cells** (exceeds WCAG 2.1 AA 24px requirement). Orchestra Centre row spans ~2 screens wide (~12–14 seats in view). Selected seats display both **✓** and seat numbers in black. Pending state uses **50% opacity Selected lime (`#CCFF00`)**. |
| [**`03_mobile_bottom_sheet_expanded.png`**](./03_mobile_bottom_sheet_expanded.png) | 390 × 844 | **Expanded Bottom Sheet**: Itemized seats with instant remove controls (✕). Subtotal (RM 300.00) without out-of-scope fee line. Tax/fee disclaimer note. Single order-level 5:00 countdown card. **"Proceed to Checkout"** primary button. |
| [**`04_mobile_edgecase_just_taken.png`**](./04_mobile_edgecase_just_taken.png) | 390 × 844 | **Case 5 (Collision / Just Taken)**: Contested seat smoothly transitions to standard unavailable grey (`#E2E8F0` with `⊘`). Collision toast is docked **just above the bottom bar**, keeping upper rows visible. |
| [**`05_mobile_edgecase_lost_hold_expired.png`**](./05_mobile_edgecase_lost_hold_expired.png) | 390 × 844 | **Case 9 (Full Hold Expired)**: When the 5-minute order timer reaches 0:00, all holds are released simultaneously. Avoids per-seat remove friction by providing a **single primary "Choose Seats Again" button** that clears the cart and returns to the venue map. |
| [**`06_mobile_edgecase_limit_reached.png`**](./06_mobile_edgecase_limit_reached.png) | 390 × 844 | **Case 6 (10-Seat Limit Reached)**: Single non-intrusive alert toast docked above the bottom bar. Peek bar displays capacity indicator (10 / 10 seats) and reads `Review Order (10) →`. |
| [**`07_mobile_edgecase_reconnecting.png`**](./07_mobile_edgecase_reconnecting.png) | 390 × 844 | **Case 10 (Reconnecting State)**: Map remains visible (slightly dimmed) rather than blanked. Realistic engineering copy: *"Live updates paused. Your seats stay held until the timer ends."* |
| [**`08_seat_state_design_matrix.png`**](./08_seat_state_design_matrix.png) | 1280 × 980 | **Master Design System Matrix & Tokens**: Complete cross-section of 6 States × 6 Tiers × 3 Zoom Levels. Documents 28px squircle / 32px tap cell geometry, "LOST: Released by venue", "Only N left" urgency rules, and viewport initial load rules. |
| [**`09_desktop_1440_overview.png`**](./09_desktop_1440_overview.png) | 1440 × 900 | **Desktop 1440 Overview Layout**: All 9 sections, full 6-tier legend, availability chips matching "Only N left", centered zoom buttons, subtotal without fee lines. |
| [**`10_mobile_edgecase_partial_loss.png`**](./10_mobile_edgecase_partial_loss.png) | 390 × 844 | **Case 7 (Partial Loss / Venue Revocation)**: Triggered when the venue or system releases a specific seat. Lost seat labeled **"LOST: Released by venue"** with red `Remove` button. Active seat retains single order countdown (03:42) in the yellow card. Explicitly displays: *"⚠️ Checkout Blocked: Remove lost seat to continue"*. |
| [**`11_mobile_edgecase_1min_warning.png`**](./11_mobile_edgecase_1min_warning.png) | 390 × 844 | **Case 8 (1-Minute Urgency Warning)**: Displays urgent red countdown timer card (`00:58`). **Every selected seat row includes the required ✕ remove control**. Primary action matches global copy: **"Proceed to Checkout"**. |
| [**`12_desktop_1440_midzoom_seats.png`**](./12_desktop_1440_midzoom_seats.png) | 1440 × 900 | **Desktop 1440 Initial Load (Mid Zoom)**: Reviewer opens on laptop and immediately sees all **4,600 individual seats** (~12px with 1px black outline) with clear state indicators (Available, Selected, Taken, Sold Out), satisfying Requirement 2 on first load. Includes **Neubrutalist hover tooltip on Row G, Seat 16** (section, row, seat, price, and availability). |

---

## 🛠️ Canvas Renderer Specifications (`theme.ts`)

### 1. Viewport & Zoom Switch Mechanics
* **Mobile Viewport ($< 768\text{px}$)**:
  * Initial load opens at **Overview ($< 0.45$)** rendering 9 solid vector section blocks.
  * Tapping any section executes an animated zoom straight to **Close Zoom ($\ge 1.20$)** centered on that section's front rows.
* **Desktop Viewport ($\ge 1024\text{px}$)**:
  * Initial load opens at **Mid Zoom ($0.45 \le \text{scale} < 1.20$, fitted scale $\approx 0.75$)** showing all 4,600+ individual seats rendered at 60 fps.
  * Hovering any seat displays a floating tooltip with Section, Row, Seat, and Price.
* **Close Zoom ($\ge 1.20$)**:
  * 28px squircle seats rendered with 2px solid black borders, 2px offset hard drop shadows, and black seat numbers.
  * Selected seats render black checkmarks (`✓`) + seat number.

### 2. Geometry & Hit Detection
* **Canvas Hit Target**: $32 \times 32\text{ px}$ bounding box per seat cell.
* **Drawn Geometry**: $28 \times 28\text{ px}$ squircle (radius 6px).
* **WCAG 2.1 AA Compliance**: Both visual seat size (28px) and tap cell (32px) exceed the 24px requirement.

### 3. Hold Timer & Order Lifecycle
* **Single Order Countdown**: A single 5:00 countdown timer starts when the first seat is held.
* **No Clock Extensions on Add**: Adding subsequent seats reserves them within the active window but does **not** restart the 5-minute clock (preventing infinite seat holding exploits).
* **Full Expiration (Case 9)**: When the 5-minute timer reaches 0:00, all held seats are released. Cart provides a single **"Choose Seats Again"** reset button.
* **Partial Revocation (Case 7)**: Occurs exclusively when the venue or system reclaims a specific seat. The lost seat displays `"LOST: Released by venue"`, and checkout is blocked until the user removes that specific seat.

### 4. Availability Chip Rules & Wording
To prevent consumer-protection regulatory violations regarding unsubstantiated urgency claims, we avoid "Selling fast" and use exact factual thresholds:
* **$> 25$ seats available**: Neutral white chip: `"42 left"`.
* **$1 – 25$ seats available**: Amber urgency chip (`#FFD166`): `"Only 18 left"`.
* **$0$ seats available**: Muted grey block (`#CBD5E1`), stroke `#64748B`, label `"SOLD OUT"`, tapping disabled.

### 5. Color Palette & Neubrutalism Tokens
* **Canvas Background**: `#F4EFE6` with `#D5CBB9` grid dots.
* **UI Background**: `#F8F5EE`.
* **Borders**: 2.5px solid `#000000`.
* **Shadows**: Hard offset 3.5px 3.5px `#000000` (zero blur).
* **Tier Colors**:
  * Orchestra Centre: `#FFB703` (Gold)
  * Orchestra Sides: `#FB8500` (Orange)
  * Mezzanine Centre: `#06D6A0` (Emerald)
  * Mezzanine Sides: `#118AB2` (Blue)
  * Balcony Centre: `#9D4EDD` (Purple)
  * Balcony Sides: `#FF70A6` (Pink)
* **Seat States**:
  * Selected: `#CCFF00` (Neon Lime)
  * Pending Hold: `rgba(204, 255, 0, 0.5)` (Lime at 50% opacity)
  * Unavailable / Taken: `#E2E8F0` with `#94A3B8` border and `⊘` mark
  * Lost / Revoked: `#FF4D4D` with `#000000` border and `✕` mark
