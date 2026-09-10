import { CLASSNAMES } from '@lobehub/ui';
import type { Theme } from 'antd-style';
import { css } from 'antd-style';

// fix ios input keyboard
// overflow: hidden;
// ref: https://zhuanlan.zhihu.com/p/113855026
const genGlobalStyle = ({ token }: { prefixCls: string; token: Theme }) => css`
  html,
  body,
  #__next {
    position: relative;

    overscroll-behavior: none;

    height: 100%;
    min-height: 100dvh;
    max-height: 100dvh;

    @media (device-width >= 576px) {
      overflow: hidden;
    }
  }

  body {
    /* Increase compositing layer, force hardware acceleration, otherwise render black edges will appear */
    will-change: opacity;
    transform: translateZ(0);
  }

  * {
    scrollbar-color: ${token.colorFill} transparent;
    scrollbar-width: thin;

    ::-webkit-scrollbar {
      width: 0.75em;
      height: 0.75em;
    }

    ::-webkit-scrollbar-thumb {
      border-radius: 10px;
    }

    :hover::-webkit-scrollbar-thumb {
      border: 3px solid transparent;
      background-color: ${token.colorText};
      background-clip: content-box;
    }

    ::-webkit-scrollbar-track {
      background-color: transparent;
    }
  }

  html.desktop[data-theme='dark'] body {
    background-color: color-mix(in srgb, ${token.colorBgLayout} 50%, transparent);
  }

  html.desktop[data-theme='light'] body {
    background-color: color-mix(in srgb, ${token.colorBgLayout} 70%, transparent);
  }

  button {
    -webkit-app-region: no-drag;
  }

  .${CLASSNAMES.ContextTrigger}[data-popup-open]:not([data-no-highlight]),
  .${CLASSNAMES.DropdownMenuTrigger}[data-popup-open]:not([data-no-highlight]) {
    background: ${token.colorFillTertiary};
  }
  .accordion-action:has(
    .${CLASSNAMES.DropdownMenuTrigger}[data-popup-open]:not([data-no-highlight])
  ) {
    opacity: 1;
  }

  /*
   * RTL fixes for @lobehub/ui base-ui Switch / Tabs / Segmented.
   *
   * Switch: page dir=rtl mirrors the flex track AND multiplies thumb travel by
   * --switch-dir:-1, so the knob/background animate the wrong way. Keep the
   * control LTR (standard toggle UX) under RTL documents.
   *
   * Tabs / Segmented indicators (Settings → Appearance animation, platform/org
   * admin tabs, etc.): JS measures a physical left offset into
   * --active-tab-left / --active-item-left, but the component CSS binds it to
   * the logical inset-inline-start. For an absolutely positioned box the
   * logical inset maps through the *containing block's* direction (the tab
   * list), not the indicator's own, so a direction:ltr rule on the indicator does
   * nothing — under RTL the pill lands mirrored (picking the first tab
   * highlights the last one).
   *
   * Fix: feed the indicator the mirrored (right-edge) distance under RTL.
   * - Tabs: Base UI already publishes --active-tab-right inline, so remap the
   *   var with !important (inline styles otherwise win). All variants derive
   *   from it, so the dot variant stays centered too.
   * - Segmented: only a left offset is published, so mirror it against the
   *   list's padding box, which is what both offsetLeft and inset percentages
   *   resolve against.
   */
  :dir(rtl) [role='switch'],
  html[dir='rtl'] [role='switch'] {
    --switch-dir: 1;

    direction: ltr;
  }

  :dir(rtl) [role='tablist'] > [role='presentation'],
  html[dir='rtl'] [role='tablist'] > [role='presentation'] {
    --active-tab-left: var(--active-tab-right) !important;
  }

  :dir(rtl) [data-orientation='horizontal'] > [aria-hidden='true']:first-of-type,
  html[dir='rtl'] [data-orientation='horizontal'] > [aria-hidden='true']:first-of-type {
    inset-inline-start: calc(100% - var(--active-item-left) - var(--active-item-width));
  }

  /**
   * Every single-line field takes its side from what is typed in it: an English
   * value runs left, a Persian value stays right, and an empty one keeps the
   * placeholder on the UI's side. That is the whole of \`unicode-bidi: plaintext\`
   * — the field's own first strong character decides, with the \`direction\`
   * property as the fallback when there is none.
   *
   * Applied globally rather than per field: a Persian UI has hundreds of inputs
   * (search, titles, names, email), and every one of them otherwise inherits the
   * page direction and pins Latin text to the wrong edge.
   *
   * Deliberately NOT extended to \`textarea\`: plaintext resolves per LINE, which
   * would let one message split across both edges. Multi-line surfaces carry
   * \`dir="auto"\` instead, which reads the whole value.
   *
   * A value with no strong character at all — a phone number, an OTP, password
   * dots — resolves LTR, which is how numbers read anyway. Only a genuinely
   * empty field falls through to \`direction\`, keeping its placeholder on the
   * UI's side.
   */
  input {
    unicode-bidi: plaintext;
  }
`;

export default genGlobalStyle;
