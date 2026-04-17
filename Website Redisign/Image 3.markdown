# Design System Document: The Kinetic Command

## 1. Overview & Creative North Star
### Creative North Star: "The Neon Observatory"
This design system moves away from the static, "boxy" nature of traditional admin dashboards. Instead, it treats the Telegram bot management interface as a high-performance command center. The aesthetic is defined by **Atmospheric Depth**—using deep charcoal voids and vibrant, self-illuminating data points. 

To break the "template" look, we employ **Intentional Asymmetry**. Large-scale typography (Manrope) is paired with condensed, high-density data modules (Inter). By overlapping translucent layers and using tonal shifts rather than hard lines, we create a UI that feels fluid, professional, and sophisticated.

---

## 2. Colors & Surface Architecture
The palette is rooted in a "Deep Space" philosophy, where the background isn't just black, but a layered series of charcoal and slate tones.

*   **The "No-Line" Rule:** 1px solid borders are strictly prohibited for sectioning. Structural boundaries must be defined solely through background color shifts. For example, a main navigation rail uses `surface-container-low`, while the primary content area sits on `surface`.
*   **Surface Hierarchy & Nesting:** Use the `surface-container` tiers to create "nested" depth. 
    *   **Level 0 (Base):** `surface` (#0c0e11)
    *   **Level 1 (Sections):** `surface-container-low` (#111417)
    *   **Level 2 (Cards/Modules):** `surface-container` (#171a1d)
    *   **Level 3 (Popovers/Active):** `surface-container-highest` (#23262a)
*   **The "Glass & Gradient" Rule:** Floating modals and sidebars must utilize Glassmorphism. Use `surface-container-high` at 80% opacity with a `20px` backdrop-blur.
*   **Signature Textures:** For high-action elements like "Start Bot" or "Deploy," use a linear gradient: `primary` (#81ecff) to `primary-dim` (#00d4ec). This provides a "liquid" feel that flat hex codes cannot replicate.

---

## 3. Typography
We utilize a dual-font strategy to balance editorial elegance with functional data density.

*   **Display & Headlines (Manrope):** Use Manrope for all `display` and `headline` scales. This typeface provides a geometric, modern "tech" feel. It should be used for page titles and high-level bot stats (e.g., "Total Users").
*   **Functional UI (Inter):** Use Inter for `title`, `body`, and `label` scales. Inter’s tall x-height ensures that even at the `label-sm` (0.6875rem) size, bot logs and API strings remain legible.
*   **Hierarchy:** High contrast is key. Use `on-surface` (#f9f9fd) for primary headers and `on-surface-variant` (#aaabaf) for secondary metadata to create a natural reading flow without needing dividers.

---

## 4. Elevation & Depth
In this design system, elevation is a product of light and tone, not structure.

*   **The Layering Principle:** Avoid shadows on static cards. Instead, place a `surface-container-highest` card atop a `surface-container-low` background. The subtle shift in hex value creates "Soft Lift."
*   **Ambient Shadows:** For floating elements (menus/tooltips), use an expansive, low-opacity shadow: `offset-y: 12px`, `blur: 40px`, `color: rgba(0, 0, 0, 0.5)`. 
*   **The "Ghost Border" Fallback:** If a component requires a boundary for accessibility (e.g., input fields), use the `outline-variant` (#46484b) at **15% opacity**.
*   **Chromatic Glow:** For active status indicators, use a `tertiary` (#8eff71) glow. Apply a `drop-shadow` with the tertiary color at 30% opacity to simulate a neon light emitting from the screen.

---

## 5. Components

### Buttons
*   **Primary:** Gradient fill (`primary` to `primary-dim`), `on-primary-fixed` text. Border radius: `md` (0.375rem).
*   **Secondary:** Ghost style. `outline-variant` at 20% opacity. Text in `primary`.
*   **Tertiary (Status):** Small scale, `label-md` type. Used for "Active" or "Live" toggles.

### Cards & Data Modules
*   **Rule:** Forbid the use of divider lines.
*   **Implementation:** Separate the "Bot Header" from the "Log Content" using a background shift from `surface-container-high` to `surface-container`. Use `xl` (0.75rem) vertical padding to create breathing room.

### Input Fields
*   **State:** Unfocused inputs should be `surface-container-lowest` with a "Ghost Border."
*   **Focus:** Transition the border to `primary` (#81ecff) and add a subtle `primary` outer glow (4px blur).

### Specialized Components
*   **Bot Status Pulsar:** A small `tertiary` circle with a CSS animation mimicking a "heartbeat" to show the bot is currently polling the Telegram API.
*   **JSON Syntax Highlighter:** For bot configurations, use a `surface-container-lowest` block with Inter `body-sm`. String values in `primary`, booleans in `tertiary`.

---

## 6. Do's and Don'ts

### Do
*   **Do** use `tertiary` (#8eff71) exclusively for positive status and succesp�%]��[�Y[Z�HH��\�[H�Ȉ�Yۘ[���
��ʊ�[X��X�H�Y�]]�H�X�K�Y�H\���\��Y[��[\K�[�ܙX\�HH\�ܘ\H��[HوHXY[�\��]\�[�Y[����\˂��
��ʊ�\�H[��\��W�ۗ��\��X�X�܈\�X�Y�]\��XZ[�Z[�Y�X�۝�\��XYX�[]H]�[��[�H�X]\�H\�[�X�]�K������ۉ���
��ۉ�
��\�H\�H�X��
�
H�܈[�][���\�[��\��X�KX�۝Z[�\�[��\���[�X���[�H�][��\�X�\����
��ۉ�
��\�HLYYܙYH�ܛ�\�ˈ]�[�H�\�\���\ۙ[����[\�HH�X
�L�\�[JH�Y]\���Y[�[Z][H[��XX�[�Y����
��ۉ�
��\�H�[�\��YH�܈[��ˈ\�HH�[X\�X[X��X��YH
�YXٙ�H�XZ[�Z[�H�[ۈY\�]X�