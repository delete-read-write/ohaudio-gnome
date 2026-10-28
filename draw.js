import Cairo from 'cairo';

// Parses "#rrggbb[aa]", "rgb(r,g,b)" or "rgba(r,g,b,a)" into [r, g, b, a] in 0..1.
export function parseColor(str) {
    const s = str.trim();
    let m = s.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})?$/i);
    if (m)
        return [m[1], m[2], m[3]].map(h => parseInt(h, 16) / 255).concat(m[4] ? parseInt(m[4], 16) / 255 : 1);
    m = s.match(/^rgba?\(([^)]+)\)$/i);
    if (m) {
        const p = m[1].split(',').map(Number);
        if (p.length >= 3 && p.every(Number.isFinite))
            return [p[0] / 255, p[1] / 255, p[2] / 255, p.length > 3 ? p[3] : 1];
    }
    return [1, 1, 1, 1];
}

export function hsl(h, s, l) {
    h = ((h % 360) + 360) % 360 / 60;
    const c = (1 - Math.abs(2 * l - 1)) * s;
    const x = c * (1 - Math.abs(h % 2 - 1));
    const [r, g, b] = h < 1 ? [c, x, 0] : h < 2 ? [x, c, 0] : h < 3 ? [0, c, x]
        : h < 4 ? [0, x, c] : h < 5 ? [x, 0, c] : [c, 0, x];
    const m = l - c / 2;
    return [r + m, g + m, b + m];
}

function roundedRect(cr, x, y, w, h, r) {
    r = Math.min(r, w / 2, h / 2);
    if (r <= 0.5) {
        cr.rectangle(x, y, w, h);
        return;
    }
    cr.newSubPath();
    cr.arc(x + w - r, y + r, r, -Math.PI / 2, 0);
    cr.arc(x + w - r, y + h - r, r, 0, Math.PI / 2);
    cr.arc(x + r, y + h - r, r, Math.PI / 2, Math.PI);
    cr.arc(x + r, y + r, r, Math.PI, 1.5 * Math.PI);
    cr.closePath();
}

// Smooth Catmull-Rom curve through pts (as cubic Béziers). `connect` continues
// the current path instead of starting a new one.
function spline(cr, pts, connect = false) {
    const n = pts.length;
    const at = i => pts[Math.max(0, Math.min(n - 1, i))];
    if (connect)
        cr.lineTo(pts[0][0], pts[0][1]);
    else
        cr.moveTo(pts[0][0], pts[0][1]);
    for (let i = 0; i < n - 1; i++) {
        const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
        cr.curveTo(
            p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6,
            p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6,
            p2[0], p2[1]);
    }
}

const WAVE_STYLES = new Set(['wave', 'fill']);

/**
 * Draws one visualizer frame.
 *  values, peaks: arrays in 0..1 (peaks may be null)
 *  o: { style, gap, rounded, centered, lineWidth, blockHeight, blockSpacing,
 *       colorMode (solid|gradient|rainbow), gradientDirection,
 *       c1, c2 (parsed [r,g,b,a] colours),
 *       rainbow: {hue (start, drifts over time), span (degrees across the width),
 *                 saturation, lightness (0..1)},
 *       orientation (bottom|top|left|right), glow (0..1), peaks, reflection, gloss, blockSquare }
 */
export function drawFrame(cr, w, h, values, peaks, o) {
    const n = values.length;
    if (!n || w <= 4 || h <= 4)
        return;
    cr.setOperator(Cairo.Operator.OVER);
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setLineCap(Cairo.LineCap.ROUND);

    // Keep room for the glow so it is not clipped at the edges.
    const glowR = o.glow > 0 ? Math.max(2, Math.min(10, Math.min(w, h) * 0.035)) : 0;
    cr.translate(glowR, glowR);
    w -= glowR * 2;
    h -= glowR * 2;

    // Growth direction: draw "from the bottom" in a rotated frame.
    switch (o.orientation) {
    case 'top':
        cr.translate(0, h);
        cr.scale(1, -1);
        break;
    case 'left':
        cr.translate(w, 0);
        cr.scale(-1, 1);
        // falls through: left is right mirrored
    case 'right':
        cr.translate(0, h);
        cr.rotate(-Math.PI / 2);
        [w, h] = [h, w];
        break;
    }

    // Waves keep the classic stroked glow; filled shapes use the cheap bloom.
    const wave = WAVE_STYLES.has(o.style);
    if (o.glow > 0 && !wave)
        bloom(cr, w, h, o.glow, c => body(c, w, h, values, null, {...o, skipReflection: true, gloss: false}, 0));
    body(cr, w, h, values, o.peaks ? peaks : null, o, wave ? glowR : 0);
}

function body(cr, w, h, values, peaks, o, glowR) {
    cr.setLineJoin(Cairo.LineJoin.ROUND);
    cr.setLineCap(Cairo.LineCap.ROUND);

    const reflect = o.reflection && !o.centered;
    const H = reflect ? h * 0.74 : h;
    paintLinear(cr, w, H, values, peaks, o, glowR);

    if (reflect && !o.skipReflection) {
        cr.save();
        cr.rectangle(0, H, w, h - H);
        cr.clip();
        cr.pushGroup();
        // Squashed mirror: the whole shape fits the band below the baseline,
        // so waves reflect completely instead of leaving loose fragments.
        const k = (h - H) / H;
        cr.translate(0, H + 1 + H * k);
        cr.scale(1, -k);
        paintLinear(cr, w, H, values, null, {...o, gloss: false}, 0);
        cr.popGroupToSource();
        const fade = new Cairo.LinearGradient(0, H, 0, h);
        fade.addColorStopRGBA(0, 0, 0, 0, 0.32);
        fade.addColorStopRGBA(1, 0, 0, 0, 0);
        cr.mask(fade);
        cr.restore();
    }
}

// Cheap bloom: render the scene into a tiny surface and stretch it back with
// bilinear filtering. Two scales give a tight core glow plus a wide halo.
const scratch = new Map();
function scratchSurface(key, w, h) {
    let s = scratch.get(key);
    if (!s || s.getWidth() !== w || s.getHeight() !== h) {
        s = new Cairo.ImageSurface(Cairo.Format.ARGB32, w, h);
        scratch.set(key, s);
    }
    return s;
}

// Renders `paint` scaled down by k into a cleared scratch surface (1 px margin).
function renderSmall(key, w, h, k, paint) {
    const surf = scratchSurface(key, Math.max(1, Math.ceil(w / k) + 2), Math.max(1, Math.ceil(h / k) + 2));
    const sc = new Cairo.Context(surf);
    sc.setOperator(Cairo.Operator.CLEAR);
    sc.paint();
    sc.setOperator(Cairo.Operator.OVER);
    sc.translate(1, 1);
    sc.scale(1 / k, 1 / k);
    paint(sc);
    sc.$dispose();
    surf.flush();
    return surf;
}

// Two blur levels (1/3 core + 1/6 halo) are combined in the small 1/3 surface,
// so only one full-size stretched paint is needed per frame.
function bloom(cr, w, h, strength, paint) {
    const core = 0.55 * strength, halo = 0.45 * strength;
    const haloSurf = renderSmall('bloom6', w, h, 6, paint);
    const coreSurf = renderSmall('bloom3', w, h, 3, paint);

    // Turn the 1/3 surface into "core * a + halo * b" with alpha premultiplied:
    // scale the core down, then add the stretched halo on top.
    const sc = new Cairo.Context(coreSurf);
    sc.setOperator(Cairo.Operator.DEST_IN);
    sc.paintWithAlpha(Math.min(1, core));
    sc.setOperator(Cairo.Operator.OVER);
    sc.translate(1, 1);
    sc.scale(2, 2);
    sc.translate(-1, -1);
    sc.setSourceSurface(haloSurf, 0, 0);
    sc.getSource().setFilter(Cairo.Filter.BILINEAR);
    sc.paintWithAlpha(Math.min(1, halo));
    sc.$dispose();
    coreSurf.flush();

    cr.save();
    cr.translate(-3, -3);
    cr.scale(3, 3);
    cr.setSourceSurface(coreSurf, 0, 0);
    cr.getSource().setFilter(Cairo.Filter.BILINEAR);
    cr.paint();
    cr.restore();
}

// ---------- Colour sources ----------

function linearSource(o, w, H, alpha) {
    // Colours arrive pre-parsed (o.c1/o.c2), so nothing is parsed per frame.
    const c1 = o.c1, c2 = o.c2;
    if (o.colorMode === 'solid')
        return solid(c1, alpha);
    if (o.colorMode === 'rainbow') {
        const {hue, span, saturation, lightness} = o.rainbow;
        // Enough stops for a smooth spectrum; fewer when only a narrow band is shown.
        const stops = Math.max(2, Math.ceil(span / 30));
        const g = new Cairo.LinearGradient(0, 0, w, 0);
        for (let i = 0; i <= stops; i++) {
            const [r, gg, b] = hsl(hue + span * i / stops, saturation, lightness);
            g.addColorStopRGBA(i / stops, r, gg, b, alpha);
        }
        return g;
    }
    const stop = (g, off, c) => g.addColorStopRGBA(off, c[0], c[1], c[2], c[3] * alpha);
    let g;
    if (o.gradientDirection === 'horizontal') {
        g = new Cairo.LinearGradient(0, 0, w, 0);
        stop(g, 0, c1);
        stop(g, 1, c2);
    } else if (o.centered) {
        g = new Cairo.LinearGradient(0, 0, 0, H);
        stop(g, 0, c2);
        stop(g, 0.5, c1);
        stop(g, 1, c2);
    } else {
        g = new Cairo.LinearGradient(0, H, 0, 0);
        stop(g, 0, c1);
        stop(g, 1, c2);
    }
    return g;
}

function solid(c, alpha) {
    return Cairo.SolidPattern.createRGBA(c[0], c[1], c[2], c[3] * alpha);
}

// Soft glow: the same path stroked several times, wide and faint to narrow and brighter.
function glowPasses(cr, buildPath, source, glowR, strength, baseWidth = 0) {
    if (!glowR || strength <= 0)
        return;
    for (const [k, a] of [[2.0, 0.05], [1.3, 0.09], [0.7, 0.16]]) {
        buildPath();
        cr.setSource(source(a * strength));
        cr.setLineWidth(baseWidth + glowR * k);
        cr.stroke();
    }
}

// ---------- Bars / blocks / waves ----------

function paintLinear(cr, w, H, values, peaks, o, glowR) {
    const n = values.length;
    const slot = w / n;
    const bw = Math.max(1, slot * (1 - o.gap / 100));
    // Each pattern (a 13-stop rainbow, for instance) is built once per pass.
    const patterns = new Map();
    const src = a => {
        let p = patterns.get(a);
        if (!p) {
            p = linearSource(o, w, H, a);
            patterns.set(a, p);
        }
        return p;
    };
    const lw = o.lineWidth;

    if (o.style === 'wave' || o.style === 'fill') {
        const pad = lw;
        const usable = H - pad * (o.centered ? 2 : 1);
        const pts = values.map((v, i) => {
            const hh = v * usable;
            return [i * slot + slot / 2, o.centered ? H / 2 - hh / 2 : H - hh];
        });
        pts.unshift([0, pts[0][1]]);
        pts.push([w, pts[pts.length - 1][1]]);
        const mirror = pts.map(([x, y]) => [x, H - y]);

        const outline = () => {
            spline(cr, pts);
            if (o.centered) {
                cr.newSubPath();
                spline(cr, mirror);
            }
        };
        const area = () => {
            spline(cr, pts);
            if (o.centered) {
                spline(cr, [...mirror].reverse(), true);
            } else {
                cr.lineTo(w, H);
                cr.lineTo(0, H);
            }
            cr.closePath();
        };

        glowPasses(cr, outline, src, glowR, o.glow, lw);
        if (o.style === 'fill') {
            // Fill fades away from the curve towards the baseline. The group is
            // clipped to the band the wave occupies, so it stays small.
            // The spline can overshoot its points a little, hence the margin.
            const top = Math.max(0, Math.min(...pts.map(p => p[1])) - lw - H * 0.08);
            cr.save();
            cr.rectangle(-lw - 2, top, w + 2 * lw + 4, (o.centered ? H - 2 * top : H - top) + 1);
            cr.clip();
            cr.pushGroup();
            area();
            cr.setSource(src(1));
            cr.fill();
            cr.popGroupToSource();
            const fade = new Cairo.LinearGradient(0, 0, 0, H);
            if (o.centered) {
                fade.addColorStopRGBA(0, 0, 0, 0, 0.6);
                fade.addColorStopRGBA(0.5, 0, 0, 0, 0.12);
                fade.addColorStopRGBA(1, 0, 0, 0, 0.6);
            } else {
                fade.addColorStopRGBA(0, 0, 0, 0, 0.65);
                fade.addColorStopRGBA(1, 0, 0, 0, 0.06);
            }
            cr.mask(fade);
            cr.restore();
        }
        outline();
        cr.setSource(src(1));
        cr.setLineWidth(lw);
        cr.stroke();
        return;
    }

    let shape;
    if (o.style === 'blocks') {
        // Square cubes: block height equals bar width, gap matches the column gap.
        const bh = o.blockSquare ? bw : o.blockHeight;
        const step = bh + (o.blockSquare ? Math.max(1, slot - bw) : o.blockSpacing);
        const sp = step - bh;
        shape = () => {
            for (let i = 0; i < n; i++) {
                const x = i * slot + (slot - bw) / 2;
                const count = Math.max(1, Math.round(values[i] * H / step));
                for (let k = 0; k < count; k++) {
                    const y = o.centered
                        ? H / 2 + (k % 2 ? 1 : -1) * Math.ceil(k / 2) * step - bh / 2
                        : H - (k + 1) * step + sp;
                    if (y < 0 || y + bh > H)
                        continue;
                    if (o.rounded && bh >= 6)
                        roundedRect(cr, x, y, bw, bh, Math.min(3, bh * 0.25));
                    else
                        cr.rectangle(x, y, bw, bh);
                }
            }
        };
    } else {
        shape = () => {
            for (let i = 0; i < n; i++) {
                const bh = Math.max(Math.min(bw, 3), values[i] * H);
                const y = o.centered ? (H - bh) / 2 : H - bh;
                roundedRect(cr, i * slot + (slot - bw) / 2, y, bw, bh, o.rounded ? bw / 2 : 0);
            }
        };
    }

    shape();
    cr.setSource(src(1));
    if (o.gloss) {
        // Glassy highlight on the top half of every bar, reusing the same path.
        cr.fillPreserve();
        const sheen = new Cairo.LinearGradient(0, 0, 0, H);
        sheen.addColorStopRGBA(0, 1, 1, 1, 0.28);
        sheen.addColorStopRGBA(o.centered ? 0.5 : 0.6, 1, 1, 1, 0.0);
        if (o.centered)
            sheen.addColorStopRGBA(1, 1, 1, 1, 0.12);
        cr.setSource(sheen);
    }
    cr.fill();

    if (peaks) {
        const capH = Math.max(1.5, Math.min(3, bw * 0.3));
        for (let i = 0; i < n; i++) {
            const p = peaks[i];
            if (p < 0.02)
                continue;
            const x = i * slot + (slot - bw) / 2;
            if (o.centered) {
                const off = p * H / 2 + 2;
                roundedRect(cr, x, H / 2 - off - capH, bw, capH, capH / 2);
                roundedRect(cr, x, H / 2 + off, bw, capH, capH / 2);
            } else {
                roundedRect(cr, x, Math.max(0, H - p * H - capH - 2), bw, capH, capH / 2);
            }
        }
        cr.setSource(src(0.95));
        cr.fill();
    }
}

// ---------- Widget background ----------

// Unit vector for an angle in degrees: 0° = up, clockwise (90° = right).
function dir(deg) {
    const a = deg * Math.PI / 180;
    return [Math.sin(a), -Math.cos(a)];
}

// Linear gradient across the box along `deg`, from start to end.
function angledGradient(w, h, deg) {
    const [dx, dy] = dir(deg);
    const L = (Math.abs(dx) * w + Math.abs(dy) * h) / 2;
    return new Cairo.LinearGradient(w / 2 - dx * L, h / 2 - dy * L, w / 2 + dx * L, h / 2 + dy * L);
}

function softSpot(cr, w, h, deg, dist, radius, rgb, alpha) {
    const [dx, dy] = dir(deg);
    const size = Math.max(w, h);
    const x = w / 2 + dx * w * dist, y = h / 2 + dy * h * dist;
    const g = new Cairo.RadialGradient(x, y, 0, x, y, size * radius);
    g.addColorStopRGBA(0, rgb[0], rgb[1], rgb[2], alpha);
    g.addColorStopRGBA(0.55, rgb[0], rgb[1], rgb[2], alpha * 0.35);
    g.addColorStopRGBA(1, rgb[0], rgb[1], rgb[2], 0);
    cr.setSource(g);
    cr.paint();
}

/**
 * Background card for the desktop widget (independent of visualizer colours).
 *  b: { mode: glass|gradient|none, radius, color, opacity (0..1), color2, angle,
 *       lighting, lightAngle, darkAngle, light, dark, softness, drift, t,
 *       highlight, border, borderColor, borderOpacity, move }
 */
export function drawBackground(cr, w, h, b) {
    const r = Math.min(b.radius, w / 2, h / 2);
    const card = () => roundedRect(cr, 0.5, 0.5, w - 1, h - 1, r);

    if (b.mode !== 'none') {
        // Everything soft is rendered at 1/4 resolution and stretched back up.
        const k = 4;
        const surf = scratchSurface('bg', Math.ceil(w / k) + 1, Math.ceil(h / k) + 1);
        const g = new Cairo.Context(surf);
        g.setOperator(Cairo.Operator.CLEAR);
        g.paint();
        g.setOperator(Cairo.Operator.OVER);
        g.scale(1 / k, 1 / k);
        paintBackgroundBody(g, w, h, b);
        g.$dispose();
        surf.flush();

        cr.save();
        card();
        cr.clip();
        cr.scale(k, k);
        cr.setSourceSurface(surf, 0, 0);
        cr.getSource().setFilter(Cairo.Filter.BILINEAR);
        cr.paint();
        cr.restore();

        if (b.border) {
            const c = parseColor(b.borderColor);
            card();
            cr.setSource(solid(c, b.borderOpacity));
            cr.setLineWidth(1);
            cr.stroke();
        }
    }

    if (b.move) {
        card();
        cr.setSource(solid([0.55, 0.7, 1, 1], 0.95));
        cr.setLineWidth(2);
        cr.stroke();
    }
}

function paintBackgroundBody(cr, w, h, b) {
    const c1 = parseColor(b.color);
    if (b.mode === 'gradient') {
        const c2 = parseColor(b.color2);
        const g = angledGradient(w, h, b.angle);
        g.addColorStopRGBA(0, c1[0], c1[1], c1[2], b.opacity);
        g.addColorStopRGBA(1, c2[0], c2[1], c2[2], b.opacity);
        cr.setSource(g);
        cr.paint();
    } else {
        cr.setSource(solid([c1[0], c1[1], c1[2], 1], b.opacity));
        cr.paint();
    }

    if (b.lighting) {
        // Directional light and shadow (like a scene light): a lit side, a dark side, soft wisps.
        const soft = 0.45 + 0.9 * b.softness;
        const drift = b.drift ? b.t : 0;
        softSpot(cr, w, h, b.darkAngle, 0.6, soft, [0, 0, 0], b.dark);
        softSpot(cr, w, h, b.lightAngle, 0.6, soft, [1, 1, 1], b.light);
        for (let i = 0; i < 3; i++) {
            const wob = 25 * Math.sin(drift * (0.11 + i * 0.05) + i * 2.1);
            softSpot(cr, w, h, b.darkAngle + 50 * (i - 1) + wob, 0.35 + 0.1 * i, soft * 0.55, [0, 0, 0], b.dark * 0.35);
            softSpot(cr, w, h, b.lightAngle - 45 * (i - 1) - wob, 0.3 + 0.12 * i, soft * 0.5, [1, 1, 1], b.light * 0.3);
        }
    }

    if (b.highlight) {
        const g = new Cairo.LinearGradient(0, 0, 0, h);
        g.addColorStopRGBA(0, 1, 1, 1, 0.09);
        g.addColorStopRGBA(0.4, 1, 1, 1, 0);
        cr.setSource(g);
        cr.paint();
    }
}
