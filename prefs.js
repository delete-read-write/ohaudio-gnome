import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';
import {_, N_, setLanguage} from './i18n.js';
import {cavaInstallCommand, findCava} from './cava.js';

// Natural two-colour palettes; picking one switches to gradient mode.
const PALETTES = [
    [N_('Ocean'), 'rgb(79,142,220)', 'rgb(143,211,232)'],
    [N_('Mint'), 'rgb(63,182,139)', 'rgb(168,230,207)'],
    [N_('Sunset'), 'rgb(224,108,117)', 'rgb(242,184,128)'],
    [N_('Lavender'), 'rgb(127,127,213)', 'rgb(195,166,240)'],
    [N_('Amber'), 'rgb(214,142,40)', 'rgb(244,208,111)'],
    [N_('Sakura'), 'rgb(232,138,168)', 'rgb(247,198,217)'],
    [N_('Forest'), 'rgb(88,140,96)', 'rgb(190,214,150)'],
    [N_('Graphite'), 'rgb(154,164,178)', 'rgb(230,233,239)'],
];

export default class OhAudioPreferences extends ExtensionPreferences {
    fillPreferencesWindow(window) {
        const s = this.getSettings();
        setLanguage(s.get_string('language'));
        window._settings = s;
        window.set_default_size(700, 860);
        window.search_enabled = true;

        const STYLES = [
            ['bars', _('Bars')],
            ['blocks', _('Blocks')],
            ['wave', _('Wave')],
            ['fill', _('Filled wave')],
        ];
        const ANGLE_HINT = _('0° is up, 90° is right, 180° is down');

        // ---- Row helpers ----
        const combo = (key, title, options, subtitle = '') => {
            const row = new Adw.ComboRow({
                title, subtitle,
                model: Gtk.StringList.new(options.map(o => o[1])),
            });
            const sync = () => {
                row.selected = Math.max(0, options.findIndex(o => o[0] === s.get_string(key)));
            };
            sync();
            row.connect('notify::selected', () => {
                const value = options[row.selected]?.[0];
                if (value && value !== s.get_string(key))
                    s.set_string(key, value);
            });
            s.connect(`changed::${key}`, sync);
            return row;
        };
        const spin = (key, title, min, max, step = 1, subtitle = '') => {
            const row = Adw.SpinRow.new_with_range(min, max, step);
            row.set({title, subtitle});
            s.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };
        const angle = (key, title) => spin(key, title, 0, 359, 15, ANGLE_HINT);
        const toggle = (key, title, subtitle = '') => {
            const row = new Adw.SwitchRow({title, subtitle});
            s.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
            return row;
        };
        const color = (key, title, subtitle = '', alpha = true) => {
            const button = new Gtk.ColorDialogButton({
                dialog: new Gtk.ColorDialog({with_alpha: alpha}),
                valign: Gtk.Align.CENTER,
            });
            const sync = () => {
                const rgba = new Gdk.RGBA();
                if (rgba.parse(s.get_string(key)))
                    button.rgba = rgba;
            };
            sync();
            button.connect('notify::rgba', () => {
                const v = button.rgba.to_string();
                if (v !== s.get_string(key))
                    s.set_string(key, v);
            });
            s.connect(`changed::${key}`, sync);
            const row = new Adw.ActionRow({title, subtitle, activatable_widget: button});
            row.add_suffix(button);
            return row;
        };
        const page = (title, icon) => {
            const p = new Adw.PreferencesPage({title, icon_name: icon});
            window.add(p);
            return p;
        };
        const group = (p, title, rows, description = '') => {
            const g = new Adw.PreferencesGroup({title, description});
            rows.forEach(r => g.add(r));
            p.add(g);
            return g;
        };

        // ---- Rows/groups appear only when the feature they belong to is on ----
        const conditional = [];
        const when = (widget, test) => {
            conditional.push([widget, test]);
            return widget;
        };
        const is = key => () => s.get_boolean(key);
        const strIs = (key, ...values) => () => values.includes(s.get_string(key));
        const all = (...tests) => () => tests.every(t => t());

        // Style options for one placement ('panel-' or 'desktop-').
        const styleGroup = (p, prefix, visible) => {
            const k = n => `${prefix}${n}`;
            const style = (...v) => strIs(k('style'), ...v);
            const notSquare = () => !s.get_boolean(k('block-square'));
            when(group(p, _('Style'), [
                combo(k('style'), _('Look'), STYLES),
                combo(k('orientation'), _('Grows from'), [
                    ['bottom', _('Bottom')], ['top', _('Top')], ['left', _('Left')], ['right', _('Right')],
                ]),
                toggle(k('centered'), _('Mirror from the centre'), _('Bars grow both ways from the middle line')),
                when(spin(k('gap'), _('Gap between bars, %'), 0, 90), style('bars', 'blocks')),
                when(toggle(k('rounded'), _('Rounded ends')), style('bars', 'blocks')),
                when(toggle(k('block-square'), _('Square cubes'), _('Every bar is stacked from little squares')), style('blocks')),
                when(spin(k('block-height'), _('Block height'), 1, 30), all(style('blocks'), notSquare)),
                when(spin(k('block-spacing'), _('Space between blocks'), 1, 20), all(style('blocks'), notSquare)),
                when(spin(k('line-width'), _('Line thickness'), 1, 20), style('wave', 'fill')),
            ]), visible);
        };

        // Colours and effects for one placement.
        const colorGroups = (p, prefix, visible) => {
            const k = n => `${prefix}${n}`;
            const mode = (...v) => strIs(k('color-mode'), ...v);
            const palette = new Adw.ComboRow({
                title: _('Ready-made palette'),
                subtitle: _('Calm, natural shades'),
                model: Gtk.StringList.new([_('My own'), ...PALETTES.map(x => _(x[0]))]),
            });
            const syncPalette = () => {
                palette.selected = 1 + PALETTES.findIndex(x =>
                    x[1] === s.get_string(k('color1')) && x[2] === s.get_string(k('color2')));
            };
            syncPalette();
            palette.connect('notify::selected', () => {
                const x = PALETTES[palette.selected - 1];
                if (!x || (x[1] === s.get_string(k('color1')) && x[2] === s.get_string(k('color2'))))
                    return;
                s.set_string(k('color1'), x[1]);
                s.set_string(k('color2'), x[2]);
                if (s.get_string(k('color-mode')) === 'rainbow')
                    s.set_string(k('color-mode'), 'gradient');
            });
            [k('color1'), k('color2')].forEach(key => s.connect(`changed::${key}`, syncPalette));

            when(group(p, _('Colour'), [
                combo(k('color-mode'), _('Colouring'), [
                    ['solid', _('Single colour')], ['gradient', _('Gradient')], ['rainbow', _('Rainbow')],
                ]),
                when(palette, mode('solid', 'gradient')),
                when(color(k('color1'), _('Main colour')), mode('solid', 'gradient')),
                when(color(k('color2'), _('Second colour')), mode('gradient')),
                when(combo(k('gradient-direction'), _('Gradient runs'), [
                    ['vertical', _('Along the bars')], ['horizontal', _('Across the bars')],
                ]), mode('gradient')),
                // Rainbow
                when(spin(k('rainbow-saturation'), _('Rainbow saturation, %'), 0, 100, 5,
                    _('Lower is softer and pastel, higher is juicier')), mode('rainbow')),
                when(spin(k('rainbow-lightness'), _('Rainbow brightness, %'), 20, 90, 2), mode('rainbow')),
                when(spin(k('rainbow-span'), _('Spectrum width, °'), 30, 720, 15,
                    _('360 shows the whole rainbow; less shows a slice, more repeats it')), mode('rainbow')),
                when(spin(k('rainbow-hue'), _('Starting colour, °'), 0, 359, 15,
                    _('0 is red, 120 is green, 240 is blue')), mode('rainbow')),
                when(spin(k('rainbow-speed'), _('Colour flow, °/s'), -360, 360, 5,
                    _('0 keeps it still, negative flows the other way')), mode('rainbow')),
                spin(k('transparency'), _('Transparency, %'), 0, 90, 5, _('0 means fully solid')),
            ]), visible);
            when(group(p, _('Effects'), [
                spin(k('glow'), _('Glow, %'), 0, 100, 5, _('0 turns it off')),
                toggle(k('peaks'), _('Falling peaks'), _('Thin caps that linger above the bars and slowly drop')),
                when(toggle(k('gloss'), _('Shine on the bars')), strIs(k('style'), 'bars', 'blocks')),
                // Reflection only for the widget: the panel is too small for it.
                ...(prefix === 'desktop-' ? [when(toggle('desktop-reflection', _('Reflection'),
                    _('A soft mirror image under the bars')), () => !s.get_boolean('desktop-centered'))] : []),
            ]), visible);
        };

        // A clear warning (with the exact command) while cava is missing.
        const cavaMissing = () => !findCava(s.get_string('cava-path'));
        const cavaWarning = p => {
            const cmd = cavaInstallCommand();
            const g = new Adw.PreferencesGroup({
                title: _('cava is not installed'),
                description: _('Without it the visualizer has nothing to listen to. Run this command in a terminal; OhAudio picks cava up by itself, no need to log out.'),
            });
            const row = new Adw.ActionRow({
                title: cmd ?? _('Install the "cava" package from your package manager.'),
                css_classes: ['monospace'],
            });
            if (cmd) {
                const copy = new Gtk.Button({icon_name: 'edit-copy-symbolic', valign: Gtk.Align.CENTER, tooltip_text: _('Copy')});
                copy.add_css_class('flat');
                copy.connect('clicked', () => {
                    copy.get_clipboard().set(cmd);
                    window.add_toast(new Adw.Toast({title: _('Copied')}));
                });
                row.add_suffix(copy);
            }
            g.add(row);
            p.add(g);
            when(g, cavaMissing);
        };

        // ================= Panel =================
        const panelPage = page(_('Panel'), 'view-paged-symbolic');
        cavaWarning(panelPage);
        group(panelPage, '', [
            toggle('show-panel', _('Visualizer in the top bar'),
                _('When off, it leaves the bar completely. You can bring it back from the system menu (OhAudio).')),
        ]);
        const onPanel = is('show-panel');
        styleGroup(panelPage, 'panel-', onPanel);
        colorGroups(panelPage, 'panel-', onPanel);
        when(group(panelPage, _('Placement'), [
            combo('panel-position', _('Side of the bar'), [
                ['left', _('Left')], ['center', _('Centre')], ['right', _('Right')],
            ]),
            spin('panel-index', _('Position in the group'), 0, 20),
            spin('panel-width', _('Width, px'), 30, 800, 10),
        ]), onPanel);

        // ================= Widget =================
        const widgetPage = page(_('Widget'), 'preferences-desktop-wallpaper-symbolic');
        group(widgetPage, '', [
            toggle('show-desktop', _('Widget on the desktop'),
                _('Also available from the system menu, next to Wi-Fi and sound')),
        ]);
        const onDesktop = is('show-desktop');

        const placeG = when(group(widgetPage, _('Position and size'), [
            combo('desktop-layer', _('Layer'), [
                ['below', _('Under the windows, on the desktop')], ['above', _('Over the windows (below the top bar and dock)')],
            ], _('Over the windows, clicks pass straight through it, and it hides for fullscreen apps')),
            toggle('desktop-move', _('Move the widget'),
                _('Drag it anywhere, resize it by the handles. Switch this off when you are done.')),
            spin('desktop-width', _('Width, px'), 120, 2000, 10),
            spin('desktop-height', _('Height, px'), 80, 1600, 10),
        ]), onDesktop);
        const reset = new Adw.ButtonRow({title: _('Back to the top-left corner')});
        reset.connect('activated', () => {
            s.set_int('desktop-x', -1);
            s.set_int('desktop-y', -1);
        });
        placeG.add(reset);

        styleGroup(widgetPage, 'desktop-', onDesktop);
        colorGroups(widgetPage, 'desktop-', onDesktop);

        const hasBg = strIs('bg-mode', 'glass', 'gradient');
        when(group(widgetPage, _('Background'), [
            combo('bg-mode', _('Background'), [
                ['none', _('None')], ['glass', _('Glass')], ['gradient', _('Gradient')],
            ]),
            when(spin('glass-blur', _('Blur'), 0, 100, 2, _('0 gives clear glass without blur')), strIs('bg-mode', 'glass')),
            when(spin('glass-brightness', _('Brightness behind the glass, %'), 30, 150, 5),
                all(strIs('bg-mode', 'glass'), () => s.get_int('glass-blur') > 0)),
            when(color('glass-color', _('Glass tint'), '', false), strIs('bg-mode', 'glass')),
            when(color('glass-color', _('Start colour'), '', false), strIs('bg-mode', 'gradient')),
            when(color('bg-color2', _('End colour'), '', false), strIs('bg-mode', 'gradient')),
            when(angle('bg-angle', _('Gradient direction, °')), strIs('bg-mode', 'gradient')),
            when(spin('glass-transparency', _('Background transparency, %'), 0, 100, 5,
                _('100 makes the background fully see-through')), hasBg),
            when(toggle('glass-highlight', _('Light along the top edge')), hasBg),
            when(spin('glass-radius', _('Corner rounding'), 0, 80), hasBg),
            spin('glass-padding', _('Inner padding'), 0, 80),
        ], _('Independent of the visualizer colours')), onDesktop);

        when(group(widgetPage, _('Light and shadow'), [
            toggle('bg-light', _('Light the background'), _('A bright side and a dark side, like a lamp shining on glass')),
            when(angle('smoke-light-angle', _('Light comes from, °')), is('bg-light')),
            when(spin('smoke-light', _('Light strength, %'), 0, 100, 2), is('bg-light')),
            when(angle('smoke-dark-angle', _('Shadow comes from, °')), is('bg-light')),
            when(spin('smoke-dark', _('Shadow strength, %'), 0, 100, 2), is('bg-light')),
            when(spin('smoke-softness', _('Softness, %'), 0, 100, 5), is('bg-light')),
            when(toggle('smoke-drift', _('Let it drift slowly'), _('Like smoke')), is('bg-light')),
        ]), all(onDesktop, hasBg));

        when(group(widgetPage, _('Border'), [
            toggle('glass-border', _('Border')),
            when(color('glass-border-color', _('Border colour'), '', false), is('glass-border')),
            when(spin('glass-border-transparency', _('Border transparency, %'), 0, 100, 2), is('glass-border')),
        ]), all(onDesktop, hasBg));

        // ================= Sound =================
        const audioPage = page(_('Sound'), 'audio-speakers-symbolic');
        cavaWarning(audioPage);
        group(audioPage, _('Analysis'), [
            toggle('autosens', _('Adjust sensitivity automatically')),
            when(spin('sensitivity', _('Sensitivity, %'), 10, 500, 10), () => !s.get_boolean('autosens')),
            spin('noise-reduction', _('Smoothing'), 0, 100, 1, _('Higher is calmer, lower is snappier')),
            toggle('monstercat', _('Monstercat effect')),
            toggle('waves', _('Wave effect')),
            toggle('stereo', _('Stereo'), _('Left and right channels, mirrored')),
            toggle('reverse', _('Reverse frequency order')),
        ]);
        group(audioPage, _('Frequencies'), [
            spin('lower-cutoff', _('Lowest frequency, Hz'), 20, 1000, 10),
            spin('higher-cutoff', _('Highest frequency, Hz'), 1000, 22000, 500),
        ]);
        const source = new Adw.EntryRow({title: _('Audio source (auto = whatever is playing)'), show_apply_button: true});
        source.text = s.get_string('source');
        source.connect('apply', () => s.set_string('source', source.text.trim() || 'auto'));
        const cavaPath = new Adw.EntryRow({title: _('Path to cava (leave empty to find it)'), show_apply_button: true});
        cavaPath.text = s.get_string('cava-path');
        cavaPath.connect('apply', () => s.set_string('cava-path', cavaPath.text.trim()));
        group(audioPage, 'CAVA', [source, cavaPath]);

        // ================= Performance =================
        const perfPage = page(_('Performance'), 'power-profile-performance-symbolic');
        group(perfPage, _('Frame rate'), [
            when(spin('panel-fps', _('Frames per second in the top bar'), 5, 144, 5,
                _('Redrawing the bar is costly (more so with a blurred bar); 30 is plenty')), is('show-panel')),
            when(spin('desktop-fps', _('Frames per second for the widget'), 5, 144, 5,
                _('Blurred glass is recalculated on every frame')), is('show-desktop')),
            spin('bars', _('Number of bars'), 4, 256, 2),
            when(spin('idle-fps', _('Frames for the drifting light'), 5, 60, 5,
                _('How smoothly light and shadow move on the background')),
            all(is('show-desktop'), is('bg-light'), is('smoke-drift'))),
        ], _('Sound is analysed exactly as often as the fastest visualizer draws, and nothing is redrawn in silence. Glow and blurred glass are the heaviest parts.'));
        group(perfPage, _('Taking a break'), [
            toggle('pause-fullscreen', _('Pause during fullscreen apps'), _('Games and videos get the whole machine')),
            toggle('hide-when-silent', _('Hide when nothing is playing')),
            when(spin('silent-seconds', _('After how many seconds'), 1, 60), is('hide-when-silent')),
        ]);

        group(perfPage, _('Language'), [
            combo('language', _('Language'), [
                ['auto', _('Same as the system')], ['en', 'English'], ['ru', 'Русский'],
            ], _('Interface language. The settings window switches the next time you open it.')),
        ]);

        const resetG = group(perfPage, _('Start over'), [], _('Bring every OhAudio setting back to its default'));
        const resetRow = new Adw.ButtonRow({title: _('Reset all settings')});
        resetRow.add_css_class('destructive-action');
        resetRow.connect('activated', () => {
            const dialog = new Adw.AlertDialog({
                heading: _('Reset all settings?'),
                body: _('Style, colours, background, widget position and size go back to their defaults. Whether the bar and the widget are shown stays as it is.'),
            });
            dialog.add_response('cancel', _('Cancel'));
            dialog.add_response('reset', _('Reset'));
            dialog.set_response_appearance('reset', Adw.ResponseAppearance.DESTRUCTIVE);
            dialog.connect('response', (_d, r) => {
                if (r !== 'reset')
                    return;
                // Where things are shown is kept, so nothing disappears unexpectedly.
                const keep = ['show-panel', 'show-desktop'];
                // No delay()/apply(): delay mode would stick to this settings object.
                s.settings_schema.list_keys().filter(key => !keep.includes(key)).forEach(key => s.reset(key));
            });
            dialog.present(window);
        });
        resetG.add(resetRow);

        // ---- Live visibility: re-evaluate on any change ----
        const refresh = () => conditional.forEach(([w, test]) => {
            w.visible = test();
        });
        refresh();
        const id = s.connect('changed', refresh);
        // Notice when cava gets installed while the window is open.
        const poll = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 3, () => {
            refresh();
            return GLib.SOURCE_CONTINUE;
        });
        window.connect('close-request', () => {
            s.disconnect(id);
            GLib.source_remove(poll);
        });
    }
}
