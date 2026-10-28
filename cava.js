import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import {_} from './i18n.js';

// Settings keys that may change the cava config (restart happens only if it really changed).
export const CAVA_KEYS = [
    'autosens', 'sensitivity', 'noise-reduction', 'monstercat', 'waves', 'stereo', 'reverse',
    'lower-cutoff', 'higher-cutoff', 'source', 'cava-path', 'bars',
    'panel-fps', 'desktop-fps', 'show-panel', 'show-desktop',
];

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

export function findCava(custom) {
    const candidates = [
        custom,
        GLib.find_program_in_path('cava'),
    ];
    return candidates.find(p => p && GLib.file_test(p, GLib.FileTest.IS_EXECUTABLE)) ?? null;
}

// The command that installs cava on this system, picked from /etc/os-release.
// Returns null when the distribution is not recognised.
export function cavaInstallCommand() {
    let ids = '';
    try {
        const [, bytes] = GLib.file_get_contents('/etc/os-release');
        const text = new TextDecoder().decode(bytes);
        ids = [...text.matchAll(/^(?:ID|ID_LIKE)=(.*)$/gm)].map(m => m[1].replace(/"/g, '')).join(' ');
    } catch {}
    const has = (...names) => names.some(n => ids.split(/\s+/).includes(n));
    if (has('fedora', 'rhel', 'centos'))
        return 'sudo dnf install cava';
    if (has('arch', 'manjaro', 'endeavouros'))
        return 'sudo pacman -S cava';
    if (has('opensuse', 'suse', 'opensuse-tumbleweed', 'opensuse-leap'))
        return 'sudo zypper install cava';
    if (has('debian', 'ubuntu', 'linuxmint', 'pop'))
        return 'sudo apt install cava';
    return null;
}

// A plain-language explanation of what is missing and how to fix it.
export function cavaMissingMessage() {
    const cmd = cavaInstallCommand();
    return cmd
        ? _('OhAudio listens to music through cava, and cava is not installed yet. Install it with:\n%s\nThe visualizer starts by itself as soon as it is there.').replace('%s', cmd)
        : _('OhAudio listens to music through cava, and cava is not installed yet. Install the "cava" package from your package manager. The visualizer starts by itself as soon as it is there.');
}

// cava only needs to run as fast as the fastest visible visualizer draws.
function framerate(s) {
    const rates = [];
    if (s.get_boolean('show-panel'))
        rates.push(s.get_int('panel-fps'));
    if (s.get_boolean('show-desktop'))
        rates.push(s.get_int('desktop-fps'));
    return clamp(Math.max(10, ...rates), 10, 144);
}

export function buildConfig(s) {
    const source = s.get_string('source').trim() || 'auto';
    if (!/^[-a-zA-Z0-9._:@]{1,240}$/.test(source))
        throw new Error(`Invalid source: ${source}`);
    return [
        '[general]',
        `framerate=${framerate(s)}`,
        `bars=${clamp(s.get_int('bars'), 4, 256)}`,
        `autosens=${+s.get_boolean('autosens')}`,
        `sensitivity=${clamp(s.get_int('sensitivity'), 10, 500)}`,
        `lower_cutoff_freq=${clamp(s.get_int('lower-cutoff'), 20, 1000)}`,
        `higher_cutoff_freq=${clamp(s.get_int('higher-cutoff'), 1000, 22000)}`,
        'sleep_timer=1',
        '[input]',
        'method=pulse',
        `source=${source}`,
        '[output]',
        'method=raw',
        'raw_target=/dev/stdout',
        'data_format=ascii',
        'ascii_max_range=1000',
        `channels=${s.get_boolean('stereo') ? 'stereo' : 'mono'}`,
        'mono_option=average',
        `reverse=${+s.get_boolean('reverse')}`,
        '[smoothing]',
        `noise_reduction=${clamp(s.get_int('noise-reduction'), 0, 100)}`,
        `monstercat=${+s.get_boolean('monstercat')}`,
        `waves=${+s.get_boolean('waves')}`,
        '',
    ].join('\n');
}

export function parseFrame(line) {
    const parts = line.split(';');
    // Trailing ';' leaves an empty last element.
    const n = parts[parts.length - 1].trim() === '' ? parts.length - 1 : parts.length;
    if (n <= 0)
        return null;
    const values = new Array(n);
    for (let i = 0; i < n; i++) {
        const v = +parts[i];
        if (!(v >= 0))
            return null;
        values[i] = v >= 1000 ? 1 : v / 1000;
    }
    return values;
}

// Runs cava with raw ascii output and calls onFrame(values) for every frame.
export class CavaStream {
    constructor(settings, onFrame, onError, onMissing) {
        this._settings = settings;
        this._onFrame = onFrame;
        this._onError = onError;
        this._onMissing = onMissing;
        this._retries = 0;
        this._config = null;
        this._configPath = GLib.build_filenamev([
            GLib.get_user_runtime_dir(), `ohaudio-gnome-${GLib.uuid_string_random()}.conf`]);
    }

    get running() {
        return !!this._proc;
    }

    // Starts cava, or restarts it only if its config actually changed.
    start() {
        let config;
        try {
            config = buildConfig(this._settings);
        } catch (e) {
            this._onError?.(e.message);
            return;
        }
        if (this._proc && config === this._config)
            return;
        this.stop();
        this._retries = Math.min(this._retries, 3);
        const bin = findCava(this._settings.get_string('cava-path'));
        if (!bin) {
            this._onMissing?.();
            this._waitForCava();
            return;
        }
        try {
            GLib.file_set_contents(this._configPath, config);
            this._config = config;
            this._cancellable = new Gio.Cancellable();
            this._proc = Gio.Subprocess.new([bin, '-p', this._configPath],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
            this._stdout = new Gio.DataInputStream({
                base_stream: this._proc.get_stdout_pipe(),
                close_base_stream: true,
            });
            this._read(this._proc, this._stdout, this._cancellable);
        } catch (e) {
            this._onError?.(e.message);
            this._proc = null;
            this._scheduleRestart();
        }
    }

    _read(proc, stream, cancellable) {
        stream.read_line_async(GLib.PRIORITY_DEFAULT, cancellable, (src, res) => {
            if (proc !== this._proc)
                return;
            let line;
            try {
                [line] = src.read_line_finish_utf8(res);
            } catch (e) {
                if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                    this._restartAfterExit();
                return;
            }
            if (line === null) {
                // cava exited on its own (device change, crash...)
                this._restartAfterExit();
                return;
            }
            const values = parseFrame(line);
            if (values) {
                this._retries = 0;
                // A failing consumer must never stop the read loop.
                try {
                    this._onFrame(values);
                } catch (e) {
                    logError(e, 'OhAudio-Gnome: frame handler failed');
                }
            }
            this._read(proc, stream, cancellable);
        });
    }

    // cava is missing: look for it every 10 s and start as soon as it shows up,
    // so installing it does not require logging out.
    _waitForCava() {
        if (this._waitId)
            return;
        this._waitId = GLib.timeout_add_seconds(GLib.PRIORITY_LOW, 10, () => {
            if (!findCava(this._settings.get_string('cava-path')))
                return GLib.SOURCE_CONTINUE;
            this._waitId = 0;
            this.start();
            return GLib.SOURCE_REMOVE;
        });
    }

    _restartAfterExit() {
        this._proc = null;
        this._config = null;
        this._scheduleRestart();
    }

    _scheduleRestart() {
        if (this._restartId || this._retries >= 10)
            return;
        const delay = Math.min(30, 2 ** this._retries++);
        this._restartId = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, delay, () => {
            this._restartId = 0;
            this.start();
            return GLib.SOURCE_REMOVE;
        });
    }

    stop() {
        if (this._waitId) {
            GLib.source_remove(this._waitId);
            this._waitId = 0;
        }
        if (this._restartId) {
            GLib.source_remove(this._restartId);
            this._restartId = 0;
        }
        this._cancellable?.cancel();
        this._cancellable = null;
        try {
            this._proc?.force_exit();
        } catch {}
        this._proc = null;
        this._stdout = null;
        this._config = null;
    }

    destroy() {
        this.stop();
        this._retries = Infinity;
        try {
            Gio.File.new_for_path(this._configPath).delete(null);
        } catch {}
    }
}
