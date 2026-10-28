import St from 'gi://St';
import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';
import * as QuickSettings from 'resource:///org/gnome/shell/ui/quickSettings.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {_, N_, setLanguage} from './i18n.js';
import {CavaStream, CAVA_KEYS, cavaMissingMessage} from './cava.js';
import {drawBackground, drawFrame, parseColor} from './draw.js';

// Labels are marked with N_() and translated when shown.
const STYLES = [
    ['bars', N_('Bars')],
    ['blocks', N_('Blocks')],
    ['wave', N_('Wave')],
    ['fill', N_('Filled wave')],
];
const BACKGROUNDS = [
    ['none', N_('None')],
    ['glass', N_('Glass')],
    ['gradient', N_('Gradient')],
];
const nameOf = (list, id) => _(list.find(s => s[0] === id)?.[1] ?? id);
const PANEL_KEYS = ['show-panel', 'panel-position', 'panel-index'];
// Keys that change the widget's actor tree (size, blur).
const DESKTOP_REBUILD_KEYS = ['desktop-width', 'desktop-height', 'desktop-style', 'bg-mode',
    'glass-blur', 'glass-brightness', 'glass-radius', 'glass-padding'];
// Keys that only change how the background is painted.
const BG_KEYS = ['glass-color', 'glass-transparency', 'bg-color2', 'bg-angle', 'bg-light',
    'smoke-light-angle', 'smoke-dark-angle', 'smoke-light', 'smoke-dark', 'smoke-softness', 'smoke-drift',
    'glass-highlight', 'glass-border', 'glass-border-color', 'glass-border-transparency'];


const scaleFactor = () => St.ThemeContext.get_for_stage(global.stage).scale_factor;
const MIN_W = 120, MIN_H = 80;

// Resize handles like a screenshot selection: [edge, x align, y align, cursor].
const HANDLES = [
    ['nw', 'START', 'START', 'NW_RESIZE'], ['n', 'CENTER', 'START', 'N_RESIZE'],
    ['ne', 'END', 'START', 'NE_RESIZE'], ['e', 'END', 'CENTER', 'E_RESIZE'],
    ['se', 'END', 'END', 'SE_RESIZE'], ['s', 'CENTER', 'END', 'S_RESIZE'],
    ['sw', 'START', 'END', 'SW_RESIZE'], ['w', 'START', 'CENTER', 'W_RESIZE'],
];

// Rounds the corners of the blurred background.
const RoundMask = GObject.registerClass(
class OhAudioRoundMask extends Shell.GLSLEffect {
    _init(w, h, r) {
        this._w = w;
        this._h = h;
        this._r = r;
        super._init();
    }

    vfunc_build_pipeline() {
        this.add_glsl_snippet(Cogl.SnippetHook.FRAGMENT, '', `
            vec2 size = vec2(${this._w.toFixed(1)}, ${this._h.toFixed(1)});
            float radius = ${this._r.toFixed(1)};
            vec2 p = cogl_tex_coord_in[0].st * size;
            vec2 q = abs(p - size * 0.5) - (size * 0.5 - vec2(radius));
            float d = length(max(q, vec2(0.0))) + min(max(q.x, q.y), 0.0) - radius;
            cogl_color_out *= 1.0 - smoothstep(-1.0, 1.0, d);`, false);
    }
});

// One visualizer (panel or widget). It only repaints when audio frames arrive.
const Visualizer = GObject.registerClass(
class OhAudioVisualizer extends St.DrawingArea {
    _init(settings, role, params) {
        super._init(params);
        this._settings = settings;
        this._prefix = role === 'desktop' ? 'desktop-' : 'panel-';
        this._values = [];
        this._peaks = [];
        this._start = GLib.get_monotonic_time();
        this.readOptions();
    }

    readOptions() {
        const s = this._settings;
        const k = name => `${this._prefix}${name}`;
        this._opts = {
            style: s.get_string(k('style')),
            orientation: s.get_string(k('orientation')),
            gap: s.get_int(k('gap')),
            rounded: s.get_boolean(k('rounded')),
            centered: s.get_boolean(k('centered')),
            lineWidth: s.get_int(k('line-width')),
            blockSquare: s.get_boolean(k('block-square')),
            blockHeight: s.get_int(k('block-height')),
            blockSpacing: s.get_int(k('block-spacing')),
            colorMode: s.get_string(k('color-mode')),
            gradientDirection: s.get_string(k('gradient-direction')),
            // Parsed once here instead of on every frame.
            c1: parseColor(s.get_string(k('color1'))),
            c2: parseColor(s.get_string(k('color2'))),
            rainbow: {
                hue: 0,
                span: s.get_int(k('rainbow-span')),
                saturation: s.get_int(k('rainbow-saturation')) / 100,
                lightness: s.get_int(k('rainbow-lightness')) / 100,
            },
            glow: s.get_int(k('glow')) / 100,
            peaks: s.get_boolean(k('peaks')),
            // The panel is too small for a reflection.
            reflection: this._prefix === 'desktop-' && s.get_boolean('desktop-reflection'),
            gloss: s.get_boolean(k('gloss')),
        };
        this._rainbowHue = s.get_int(k('rainbow-hue'));
        this._rainbowSpeed = s.get_int(k('rainbow-speed'));
        this.baseOpacity = Math.round(255 * (1 - s.get_int(k('transparency')) / 100));
        this.opacity = this.baseOpacity;
        this._minInterval = 1e6 / Math.max(5, s.get_int(k('fps'))) - 2000;
        this._lastPaint = 0;
        this._silentPainted = false;
        this.queue_repaint();
    }

    clear() {
        this._values = [];
        this._peaks = [];
        this.queue_repaint();
    }

    // Peak caps: hold for a moment, then fall with gravity.
    _updatePeaks(values, now) {
        const n = values.length;
        if (this._peaks.length !== n) {
            this._peaks = values.slice();
            this._peakHold = new Array(n).fill(now);
            this._peakVel = new Array(n).fill(0);
        }
        const dt = this._lastPeak ? Math.min(0.1, (now - this._lastPeak) / 1e6) : 0;
        this._lastPeak = now;
        for (let i = 0; i < n; i++) {
            const v = values[i];
            if (v >= this._peaks[i]) {
                this._peaks[i] = v;
                this._peakHold[i] = now + 350000;
                this._peakVel[i] = 0;
            } else if (now > this._peakHold[i]) {
                this._peakVel[i] += 2.4 * dt;
                this._peaks[i] = Math.max(v, this._peaks[i] - this._peakVel[i] * dt);
            }
        }
    }

    update(values) {
        const now = GLib.get_monotonic_time();
        this._values = values;
        if (this._opts.peaks)
            this._updatePeaks(values, now);

        // Nothing to paint while hidden (fullscreen app, faded out, overview...).
        if (!this.mapped || this.opacity === 0)
            return;
        // Silence that is already on screen would paint an identical frame.
        const silent = values.every(v => v < 0.003) &&
            (!this._opts.peaks || this._peaks.every(v => v < 0.003));
        if (silent && this._silentPainted)
            return;
        // Per-placement frame cap.
        if (!silent && now - this._lastPaint < this._minInterval)
            return;
        // A frame that moves no bar by more than about half a pixel looks the
        // same as the one on screen; skip it.
        if (!silent && this._painted?.length === values.length) {
            const eps = 0.5 / Math.max(1, this.width, this.height);
            let i = 0;
            while (i < values.length && Math.abs(values[i] - this._painted[i]) < eps)
                i++;
            if (i === values.length)
                return;
        }
        this._painted = values;
        this._lastPaint = now;
        this._silentPainted = silent;
        this.queue_repaint();
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        try {
            const t = (GLib.get_monotonic_time() - this._start) / 1e6;
            this._opts.rainbow.hue = this._rainbowHue + t * this._rainbowSpeed;
            drawFrame(cr, w, h, this._values, this._peaks, this._opts);
        } catch (e) {
            logError(e, 'OhAudio-Gnome: draw failed');
        } finally {
            cr.$dispose();
        }
    }
});

// Background card (glass tint / gradient, border, move outline).
const Background = GObject.registerClass(
class OhAudioBackground extends St.DrawingArea {
    _init(settings, radius, params) {
        super._init(params);
        this._settings = settings;
        this._radius = radius;
        this._start = GLib.get_monotonic_time();
        this.readOptions();
    }

    readOptions() {
        const s = this._settings;
        this._b = {
            // Old "solid" values fall back to glass.
            mode: ['none', 'gradient'].includes(s.get_string('bg-mode')) ? s.get_string('bg-mode') : 'glass',
            radius: this._radius,
            color: s.get_string('glass-color'),
            opacity: 1 - s.get_int('glass-transparency') / 100,
            color2: s.get_string('bg-color2'),
            angle: s.get_int('bg-angle'),
            lighting: s.get_boolean('bg-light'),
            lightAngle: s.get_int('smoke-light-angle'),
            darkAngle: s.get_int('smoke-dark-angle'),
            light: s.get_int('smoke-light') / 100,
            dark: s.get_int('smoke-dark') / 100,
            softness: s.get_int('smoke-softness') / 100,
            drift: s.get_boolean('smoke-drift'),
            highlight: s.get_boolean('glass-highlight'),
            border: s.get_boolean('glass-border'),
            borderColor: s.get_string('glass-border-color'),
            borderOpacity: 1 - s.get_int('glass-border-transparency') / 100,
            move: s.get_boolean('desktop-move'),
        };
        this.visible = this._b.mode !== 'none' || this._b.move;
        this.queue_repaint();
    }

    // Only drifting light needs repaints without audio.
    get animated() {
        const b = this._b;
        return b.mode !== 'none' && b.lighting && b.drift;
    }

    vfunc_repaint() {
        const cr = this.get_context();
        const [w, h] = this.get_surface_size();
        try {
            const t = (GLib.get_monotonic_time() - this._start) / 1e6;
            drawBackground(cr, w, h, {...this._b, t});
        } catch (e) {
            logError(e, 'OhAudio-Gnome: background failed');
        } finally {
            cr.$dispose();
        }
    }
});

// Desktop widget under the windows. While moving it is lifted just above the
// windows (still below the top bar and the dock) so it receives the pointer.
class DesktopWidget {
    constructor(ext) {
        this._ext = ext;
        this._settings = ext._settings;
        // When the shell itself goes away (logout, shutdown) its groups are
        // destroyed with our actor inside: never try to rebuild then.
        const lm = Main.layoutManager;
        this._groupIds = [lm.uiGroup, lm._backgroundGroup].map(g =>
            [g, g.connect('destroy', () => (this._destroyed = true))]);
        this._build();
        this._monitorsId = lm.connect('monitors-changed', () => this.place());
        this._workareasId = global.display.connect('workareas-changed', () => this.place());
    }

    _build() {
        const s = this._settings;
        const sf = scaleFactor();
        const w = s.get_int('desktop-width'), h = s.get_int('desktop-height');
        // Radius and padding are tuned for ~300 px and grow with the widget.
        const k = Math.max(1, Math.min(2.5, Math.min(w, h) / 300));
        const radius = Math.round(Math.min(s.get_int('glass-radius') * k, Math.min(w, h) / 2));
        const padding = Math.round(s.get_int('glass-padding') * k);
        const mode = s.get_string('bg-mode');

        this.actor = new St.Widget({
            reactive: true,
            layout_manager: new Clutter.BinLayout(),
            width: w * sf,
            height: h * sf,
        });
        // The shell may destroy children of its groups on its own (e.g. when it
        // rebuilds the desktop background). Then rebuild instead of touching a
        // disposed actor.
        this.actor.connect('destroy', () => {
            if (this._tearingDown)
                return;
            // Always drop references to the dead actors...
            this.actor = this.area = this.background = null;
            this._grab = this._drag = null;
            this._parent = null;
            // ...but rebuild only if the shell itself is not going away.
            if (this._destroyed)
                return;
            this._rebuildId ||= GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                this._rebuildId = 0;
                if (!this._destroyed && !this.actor) {
                    try {
                        this._build();
                        this._ext._syncDesktopVisible();
                    } catch (e) {
                        logError(e, 'OhAudio-Gnome: widget rebuild failed');
                    }
                }
                return GLib.SOURCE_REMOVE;
            });
        });

        if (!['none', 'gradient'].includes(mode) && s.get_int('glass-blur') > 0) {
            const blur = new St.Widget({x_expand: true, y_expand: true});
            blur.add_effect(new RoundMask(w * sf, h * sf, radius * sf));
            blur.add_effect(new Shell.BlurEffect({
                mode: Shell.BlurMode.BACKGROUND,
                radius: s.get_int('glass-blur') * sf,
                brightness: s.get_int('glass-brightness') / 100,
            }));
            this.actor.add_child(blur);
        }

        this.background = new Background(s, radius * sf, {x_expand: true, y_expand: true});
        this.actor.add_child(this.background);

        const pad = padding * sf;
        // References are dropped by _teardown() and the actor's destroy handler.
        this.area = new Visualizer(s, 'desktop', {
            x_expand: true, y_expand: true,
            margin_left: pad, margin_right: pad, margin_top: pad, margin_bottom: pad,
        });
        this.actor.add_child(this.area);

        this._hint = new St.Label({
            style_class: 'ohaudio-move-hint',
            text: _('Drag to move · pull the handles to resize'),
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
            visible: false,
        });
        this.actor.add_child(this._hint);

        this._handles = HANDLES.map(([edge, xa, ya, cursor]) => {
            const handle = new St.Widget({
                style_class: 'ohaudio-handle',
                reactive: true,
                visible: false,
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign[xa],
                y_align: Clutter.ActorAlign[ya],
            });
            if ('cursor_type' in handle)
                handle.cursor_type = Clutter.CursorType[cursor];
            handle.connect('button-press-event', (_a, e) => this._onHandlePress(edge, e));
            this.actor.add_child(handle);
            return handle;
        });

        this.actor.connect('button-press-event', (_a, e) => this._onPress(e));
        this.actor.connect('motion-event', (_a, e) => this._onMotion(e));
        this.actor.connect('button-release-event', () => this._onRelease());

        this._parent = null;
        this.setMoveMode(s.get_boolean('desktop-move'));
        this.place();
    }

    rebuild() {
        const visible = this.actor?.visible ?? true;
        this._teardown();
        this._build();
        this.actor.visible = visible;
    }

    setMoveMode(on) {
        if (!this.actor)
            return;
        if (!on)
            this._endDrag(true);
        this._move = on;
        this._hint.visible = on;
        this._handles.forEach(h => (h.visible = on));
        if ('cursor_type' in this.actor)
            this.actor.cursor_type = on ? Clutter.CursorType.MOVE : Clutter.CursorType.DEFAULT;
        this.background.readOptions();

        this._attach();
    }

    // "above": right above the windows, still below the top bar and the dock.
    // "below": on the desktop under the windows. While moving it is always
    // above the windows so it receives the pointer.
    _attach() {
        const above = this._move || this._settings.get_string('desktop-layer') === 'above';
        const parent = above ? Main.layoutManager.uiGroup : Main.layoutManager._backgroundGroup;
        if (this._parent !== parent) {
            this._parent?.remove_child(this.actor);
            if (above)
                parent.insert_child_above(this.actor, global.window_group);
            else
                parent.add_child(this.actor);
            this._parent = parent;
        }
        // Above the windows the widget must not swallow clicks meant for them.
        this.actor.reactive = this._move || !above;
    }

    get aboveWindows() {
        return this._parent === Main.layoutManager.uiGroup;
    }

    place() {
        if (!this.actor)
            return;
        const sf = scaleFactor();
        let x = this._settings.get_int('desktop-x'), y = this._settings.get_int('desktop-y');
        if (x < 0 || y < 0) {
            // Default: top-left corner of the primary work area (below the top bar).
            const a = Main.layoutManager.getWorkAreaForMonitor(Main.layoutManager.primaryIndex);
            x = a.x + 24 * sf;
            y = a.y + 24 * sf;
        } else {
            x *= sf;
            y *= sf;
        }
        this.actor.set_position(...this._clamp(x, y));
    }

    // The whole stage (all monitors), not just the work area.
    _clamp(x, y) {
        return [
            Math.round(Math.max(0, Math.min(global.stage.width - this.actor.width, x))),
            Math.round(Math.max(0, Math.min(global.stage.height - this.actor.height, y))),
        ];
    }

    _onPress(e) {
        const button = e.get_button();
        if (button === Clutter.BUTTON_SECONDARY) {
            this._ext.openPreferences();
            return Clutter.EVENT_STOP;
        }
        if (!this._move || button !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = e.get_coords();
        this._drag = {x, y, ox: this.actor.x, oy: this.actor.y};
        this._grab = global.stage.grab(this.actor);
        return Clutter.EVENT_STOP;
    }

    _onHandlePress(edge, e) {
        if (!this._move || e.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = e.get_coords();
        const a = this.actor;
        this._drag = {edge, x, y, ox: a.x, oy: a.y, ow: a.width, oh: a.height};
        this._grab = global.stage.grab(this.actor);
        return Clutter.EVENT_STOP;
    }

    _onMotion(e) {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;
        const [x, y] = e.get_coords();
        const d = this._drag;
        if (d.edge)
            this._resizeTo(d, x - d.x, y - d.y);
        else
            this.actor.set_position(...this._clamp(d.ox + x - d.x, d.oy + y - d.y));
        return Clutter.EVENT_STOP;
    }

    // Live resize from a handle; the opposite edge stays put.
    _resizeTo(d, dx, dy) {
        const sf = scaleFactor();
        const e = d.edge;
        let w = d.ow, h = d.oh;
        if (e.includes('e'))
            w = d.ow + dx;
        if (e.includes('w'))
            w = d.ow - dx;
        if (e.includes('s'))
            h = d.oh + dy;
        if (e.includes('n'))
            h = d.oh - dy;
        w = Math.max(MIN_W * sf, Math.min(global.stage.width, w));
        h = Math.max(MIN_H * sf, Math.min(global.stage.height, h));
        const x = e.includes('w') ? d.ox + d.ow - w : d.ox;
        const y = e.includes('n') ? d.oy + d.oh - h : d.oy;
        this.actor.set_size(Math.round(w), Math.round(h));
        this.actor.set_position(...this._clamp(x, y));
    }

    _onRelease() {
        if (!this._drag)
            return Clutter.EVENT_PROPAGATE;
        this._endDrag(true);
        return Clutter.EVENT_STOP;
    }

    // Saves position (and size after a resize). While `saving` is set the
    // x/y handlers do not re-place the widget, so writing x first cannot reset y.
    // (No settings.delay(): it would leave this shared GSettings object in
    // delay-apply mode for good, and every later write would be silently queued.)
    _save(withSize) {
        const s = this._settings;
        const sf = scaleFactor();
        const x = Math.max(0, Math.round(this.actor.x / sf));
        const y = Math.max(0, Math.round(this.actor.y / sf));
        const w = Math.round(this.actor.width / sf);
        const h = Math.round(this.actor.height / sf);
        this.saving = true;
        try {
            s.set_int('desktop-x', x);
            s.set_int('desktop-y', y);
        } finally {
            this.saving = false;
        }
        // A size change rebuilds the widget, which then places itself at the saved x/y.
        if (withSize) {
            s.set_int('desktop-width', w);
            s.set_int('desktop-height', h);
        }
    }

    _endDrag(save) {
        this._grab?.dismiss();
        this._grab = null;
        const d = this._drag;
        if (!d)
            return;
        this._drag = null;
        if (save && this.actor)
            this._save(!!d.edge);
    }

    get dragging() {
        return !!this._drag;
    }

    _teardown() {
        this._endDrag(false);
        this._tearingDown = true;
        try {
            this.actor?.destroy();
        } finally {
            this._tearingDown = false;
        }
        this.actor = null;
        this.area = null;
        this.background = null;
    }

    destroy() {
        this._destroyed = true;
        if (this._rebuildId)
            GLib.source_remove(this._rebuildId);
        this._rebuildId = 0;
        Main.layoutManager.disconnect(this._monitorsId);
        global.display.disconnect(this._workareasId);
        this._groupIds.forEach(([g, id]) => g.disconnect(id));
        this._teardown();
    }
}

// System menu toggle: on/off for the whole visualizer plus a menu with the
// panel / widget switches. Stays available when both are hidden.
const OhAudioToggle = GObject.registerClass(
class OhAudioToggle extends QuickSettings.QuickMenuToggle {
    _init(ext) {
        super._init({title: 'OhAudio', iconName: 'audio-x-generic-symbolic', toggleMode: true});
        this._ext = ext;
        const s = this._settings = ext._settings;
        this.menu.setHeader('audio-x-generic-symbolic', 'OhAudio', _('Music visualizer'));

        const sw = (label, key) => {
            const item = new PopupMenu.PopupSwitchMenuItem(label, s.get_boolean(key));
            item.connect('toggled', (_i, on) => s.set_boolean(key, on));
            this.menu.addMenuItem(item);
            return item;
        };
        this._panel = sw(_('In the top bar'), 'show-panel');
        this._desktop = sw(_('On the desktop'), 'show-desktop');
        this._move = sw(_('Move the widget'), 'desktop-move');
        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const prefs = new PopupMenu.PopupMenuItem(_('Settings…'));
        prefs.connect('activate', () => {
            Main.panel.closeQuickSettings?.();
            ext.openPreferences();
        });
        this.menu.addMenuItem(prefs);

        // Remember what was shown so switching back on restores it.
        this._last = {panel: false, desktop: true};
        this.connect('clicked', () => {
            const any = s.get_boolean('show-panel') || s.get_boolean('show-desktop');
            if (any) {
                this._last = {panel: s.get_boolean('show-panel'), desktop: s.get_boolean('show-desktop')};
                s.set_boolean('show-panel', false);
                s.set_boolean('show-desktop', false);
            } else {
                s.set_boolean('show-panel', this._last.panel);
                s.set_boolean('show-desktop', this._last.desktop || !this._last.panel);
            }
        });
        this._id = s.connect('changed', () => this._sync());
        this.connect('destroy', () => s.disconnect(this._id));
        this._sync();
    }

    _sync() {
        const s = this._settings;
        const panel = s.get_boolean('show-panel'), desktop = s.get_boolean('show-desktop');
        this.checked = panel || desktop;
        this.subtitle = panel && desktop ? _('Bar and widget') : panel ? _('Top bar') : desktop ? _('Widget') : _('Off');
        this._panel.setToggleState(panel);
        this._desktop.setToggleState(desktop);
        this._move.setToggleState(s.get_boolean('desktop-move'));
        this._move.visible = desktop;
    }
});

const OhAudioIndicator = GObject.registerClass(
class OhAudioIndicator extends QuickSettings.SystemIndicator {
    _init(ext) {
        super._init();
        this.quickSettingsItems.push(new OhAudioToggle(ext));
    }
});

export default class OhAudioExtension extends Extension {
    enable() {
        this._settings = this.getSettings();
        setLanguage(this._settings.get_string('language'));
        this._hidden = false;
        this._paused = false;
        this._running = false;
        if (!this._settings.get_boolean('show-desktop'))
            this._settings.set_boolean('desktop-move', false);

        this._cava = new CavaStream(this._settings,
            values => this._onFrame(values),
            msg => console.warn(`OhAudio-Gnome: ${msg}`),
            () => {
                // Said once per session, in the journal and as a notification.
                if (this._missingNotified)
                    return;
                this._missingNotified = true;
                const msg = cavaMissingMessage();
                console.warn(`OhAudio-Gnome: cava is not installed. ${msg.replace(/\n/g, ' ')}`);
                Main.notify(_('OhAudio needs cava'), msg);
            });

        this._buildPanel();
        this._buildDesktop();
        this._settingsId = this._settings.connect('changed', (_s, key) => this._onSetting(key));
        this._fullscreenId = global.display.connect('in-fullscreen-changed', () => this._syncRunning());

        // Always-reachable switch in the system menu, even with panel and widget off.
        this._quick = new OhAudioIndicator(this);
        Main.panel.statusArea.quickSettings.addExternalIndicator(this._quick);
        this._syncRunning();
    }

    disable() {
        this._settings.disconnect(this._settingsId);
        global.display.disconnect(this._fullscreenId);
        this._stopTimer();
        if (this._panelIdleId)
            GLib.source_remove(this._panelIdleId);
        this._panelIdleId = 0;
        this._quick.quickSettingsItems.forEach(i => i.destroy());
        this._quick.destroy();
        this._quick = null;
        if (this._silenceId)
            GLib.source_remove(this._silenceId);
        this._silenceId = 0;
        this._cava.destroy();
        this._cava = null;
        this._destroyPanel();
        this._desktop?.destroy();
        this._desktop = null;
        this._settings = null;
    }

    // A failing handler must not leave the extension half-updated.
    _onSetting(key) {
        try {
            this._applySetting(key);
            // cava restarts only if its config text actually changed.
            if (CAVA_KEYS.includes(key) && this._running)
                this._cava.start();
        } catch (e) {
            logError(e, `OhAudio-Gnome: applying "${key}" failed`);
        }
    }

    _applySetting(key) {
        const s = this._settings;
        if (key === 'language') {
            // Rebuild everything that shows text in the new language.
            setLanguage(s.get_string('language'));
            this._destroyPanel();
            this._buildPanel();
            this._quick.quickSettingsItems.forEach(i => i.destroy());
            this._quick.destroy();
            this._quick = new OhAudioIndicator(this);
            Main.panel.statusArea.quickSettings.addExternalIndicator(this._quick);
            this._desktop?.rebuild();
            this._syncDesktopVisible();
        } else if (PANEL_KEYS.includes(key)) {
            // Close the menu first and rebuild on idle: destroying the button
            // while its menu is open breaks the menu's BoxPointer.
            this._button?.menu.close(false);
            if (!this._panelIdleId) {
                this._panelIdleId = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
                    this._panelIdleId = 0;
                    this._destroyPanel();
                    this._buildPanel();
                    this._syncRunning();
                    return GLib.SOURCE_REMOVE;
                });
            }
        } else if (key === 'panel-width') {
            if (this._panelArea)
                this._panelArea.width = s.get_int('panel-width');
        } else if (key === 'desktop-layer') {
            if (this._desktop?.actor)
                this._desktop._attach();
            this._syncDesktopVisible();
        } else if (key === 'show-desktop') {
            if (!s.get_boolean('show-desktop'))
                s.set_boolean('desktop-move', false);
            this._desktop?.destroy();
            this._desktop = null;
            this._buildDesktop();
            this._syncRunning();
        } else if (DESKTOP_REBUILD_KEYS.includes(key)) {
            this._desktop?.rebuild();
            this._syncTimer();
        } else if (BG_KEYS.includes(key)) {
            this._desktop?.background?.readOptions();
            this._syncTimer();
        } else if (key === 'desktop-x' || key === 'desktop-y') {
            if (!this._desktop?.dragging && !this._desktop?.saving)
                this._desktop?.place();
        } else if (key === 'desktop-move') {
            this._desktop?.setMoveMode(s.get_boolean('desktop-move'));
            this._setHidden(false);
            this._syncDesktopVisible();
        } else if (key === 'hide-when-silent' || key === 'silent-seconds') {
            this._setHidden(false);
            this._armSilence();
        } else if (key === 'pause-fullscreen') {
            this._syncRunning();
        } else {
            this._panelArea?.readOptions();
            this._desktop?.area?.readOptions();
            this._syncTimer();
        }
        this._syncMenu();
    }

    // cava runs only while something is shown and no fullscreen app asks for a pause.
    _syncRunning() {
        const s = this._settings;
        this._paused = s.get_boolean('pause-fullscreen') &&
            Main.layoutManager.monitors.some(m => m.inFullscreen);
        const run = !this._paused && (s.get_boolean('show-panel') || s.get_boolean('show-desktop'));
        this._syncDesktopVisible();
        if (run !== this._running) {
            this._running = run;
            if (run) {
                this._cava.start();
                this._armSilence();
            } else {
                this._cava.stop();
                this._armSilence();
                this._panelArea?.clear();
                this._desktop?.area?.clear();
            }
        }
        this._syncTimer();
    }

    // Low-rate repaint for the drifting light on the widget background.
    _syncTimer() {
        this._stopTimer();
        if (!this._running || this._hidden || !this._desktop?.background?.animated)
            return;
        const fps = Math.max(5, Math.min(60, this._settings.get_int('idle-fps')));
        this._timerId = GLib.timeout_add(GLib.PRIORITY_DEFAULT_IDLE, Math.round(1000 / fps), () => {
            this._desktop?.background?.queue_repaint();
            return GLib.SOURCE_CONTINUE;
        });
    }

    _stopTimer() {
        if (this._timerId)
            GLib.source_remove(this._timerId);
        this._timerId = 0;
    }

    // Panel off means nothing in the panel at all (no icon); the widget's
    // right-click and the extension preferences stay available.
    _buildPanel() {
        const s = this._settings;
        if (!s.get_boolean('show-panel'))
            return;
        this._button = new PanelMenu.Button(0.5, 'OhAudio-Gnome', false);
        this._button.add_style_class_name('ohaudio-button');
        const area = this._panelArea = new Visualizer(s, 'panel', {
            style_class: 'ohaudio-area',
            y_expand: true,
            width: s.get_int('panel-width'),
        });
        area.connect('destroy', () => {
            if (this._panelArea === area)
                this._panelArea = null;
        });
        this._button.add_child(area);
        this._buildMenu();
        Main.panel.addToStatusArea(this.uuid, this._button,
            s.get_int('panel-index'), s.get_string('panel-position'));
    }

    _destroyPanel() {
        this._button?.destroy();
        this._button = null;
        this._panelArea = null;
        this._menuItems = null;
    }

    _buildDesktop() {
        if (!this._settings.get_boolean('show-desktop'))
            return;
        this._desktop = new DesktopWidget(this);
        this._syncDesktopVisible();
    }

    // The blurred glass ignores the parent's opacity, so the widget is fully
    // hidden (not just faded) while paused or silent.
    _syncDesktopVisible() {
        const a = this._desktop?.actor;
        if (!a)
            return;
        const fullscreen = this._desktop.aboveWindows && !this._settings.get_boolean('desktop-move') &&
            Main.layoutManager.monitors.some(m => m.inFullscreen);
        if (this._paused || this._hidden || fullscreen) {
            a.visible = false;
        } else {
            a.visible = true;
            a.opacity = 255;
        }
    }

    // Tray menu: one section for the panel, one for the desktop widget.
    _buildMenu() {
        const s = this._settings;
        const menu = this._button.menu;

        const sw = (label, key) => {
            const item = new PopupMenu.PopupSwitchMenuItem(label, s.get_boolean(key));
            item.connect('toggled', (_i, on) => s.set_boolean(key, on));
            menu.addMenuItem(item);
            return item;
        };
        const chooser = (key, list, label) => {
            const sub = new PopupMenu.PopupSubMenuMenuItem('');
            const items = list.map(([id, name]) => {
                const item = new PopupMenu.PopupMenuItem(_(name));
                item.connect('activate', () => s.set_string(key, id));
                sub.menu.addMenuItem(item);
                return [id, item];
            });
            menu.addMenuItem(sub);
            return {sub, key, list, label, items};
        };

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Top bar')));
        const panelStyle = chooser('panel-style', STYLES, _('Style'));
        const hide = new PopupMenu.PopupMenuItem(_('Remove from the bar'));
        hide.connect('activate', () => s.set_boolean('show-panel', false));
        menu.addMenuItem(hide);

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem(_('Widget')));
        const desktop = sw(_('Widget on the desktop'), 'show-desktop');
        const desktopStyle = chooser('desktop-style', STYLES, _('Style'));
        const background = chooser('bg-mode', BACKGROUNDS, _('Background'));
        const move = sw(_('Move the widget'), 'desktop-move');

        menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());
        const prefs = new PopupMenu.PopupMenuItem(_('All settings…'));
        prefs.connect('activate', () => this.openPreferences());
        menu.addMenuItem(prefs);

        this._menuItems = {panelStyle, desktop, desktopStyle, background, move};
        menu.connect('open-state-changed', (_m, open) => {
            if (open)
                this._syncMenu();
        });
        this._syncMenu();
    }

    _syncMenu() {
        const m = this._menuItems;
        if (!m)
            return;
        const s = this._settings;
        const onDesktop = s.get_boolean('show-desktop');
        m.desktop.setToggleState(onDesktop);
        m.move.setToggleState(s.get_boolean('desktop-move'));
        for (const c of [m.panelStyle, m.desktopStyle, m.background]) {
            const current = s.get_string(c.key);
            c.sub.label.text = `${c.label}: ${nameOf(c.list, current)}`;
            for (const [id, item] of c.items)
                item.setOrnament(id === current ? PopupMenu.Ornament.CHECK : PopupMenu.Ornament.NONE);
        }
        m.desktopStyle.sub.visible = onDesktop;
        m.background.sub.visible = onDesktop;
        m.move.visible = onDesktop;
    }

    _onFrame(values) {
        if (values.some(v => v > 0.01)) {
            this._lastSound = GLib.get_monotonic_time();
            if (this._hidden)
                this._setHidden(false);
        }
        if (this._hidden || !this._running)
            return;
        this._panelArea?.update(values);
        this._desktop?.area?.update(values);
    }

    // "Hide when silent": one cheap check per second against the time of the
    // last loud frame. (cava stops sending frames while it is silent, so the
    // silence cannot be counted from frames themselves.)
    _armSilence() {
        if (this._silenceId)
            GLib.source_remove(this._silenceId);
        this._silenceId = 0;
        this._lastSound = GLib.get_monotonic_time();
        if (!this._running || !this._settings.get_boolean('hide-when-silent'))
            return;
        this._silenceId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 1, () => {
            const limit = Math.max(1, this._settings.get_int('silent-seconds')) * 1e6;
            if (!this._hidden && GLib.get_monotonic_time() - this._lastSound >= limit)
                this._setHidden(true);
            return GLib.SOURCE_CONTINUE;
        });
    }

    // Fades the visualizers out while it is silent; the widget (with its glass)
    // is then hidden completely.
    _setHidden(hidden) {
        if (hidden && this._settings.get_boolean('desktop-move'))
            hidden = false;
        if (this._hidden === hidden)
            return;
        this._hidden = hidden;
        const desktop = this._desktop?.actor;
        if (!hidden)
            this._syncDesktopVisible();
        for (const target of [this._panelArea, desktop].filter(Boolean)) {
            target.remove_all_transitions();
            if (!hidden && target === desktop)
                target.opacity = 0;
            target.ease({
                opacity: hidden ? 0 : target === this._panelArea
                    ? this._panelArea.baseOpacity : 255,
                duration: 500,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    if (hidden && target === desktop && this._hidden)
                        this._syncDesktopVisible();
                },
            });
        }
        this._syncTimer();
    }
}
