use crate::models::PlayerBounds;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) struct ClipRect {
    pub left: i32,
    pub top: i32,
    pub right: i32,
    pub bottom: i32,
}

/// Window-local clipping shared by mpv's child and the owned controls window.
/// The original video size is preserved while its position follows the page.
pub(crate) fn visible_clip(bounds: &PlayerBounds, client: (i32, i32)) -> Option<ClipRect> {
    if !bounds.visible
        || ![
            bounds.x,
            bounds.y,
            bounds.width,
            bounds.height,
            bounds.viewport_top,
        ]
        .iter()
        .all(|v| v.is_finite())
        || bounds.width <= 1.
        || bounds.height <= 1.
        || bounds.width > 16384.
        || bounds.height > 16384.
        || bounds.x.abs() > 32768.
        || bounds.y.abs() > 32768.
        || bounds.viewport_top < 0.
        || bounds.viewport_top > client.1 as f64
        || client.0 <= 0
        || client.1 <= 0
    {
        return None;
    }
    let (x, y) = (bounds.x.round() as i32, bounds.y.round() as i32);
    let clip = ClipRect {
        left: (-x).max(0),
        top: (bounds.viewport_top.ceil() as i32 - y).max(0),
        right: (client.0 - x).min(bounds.width.round() as i32),
        bottom: (client.1 - y).min(bounds.height.round() as i32),
    };
    (clip.right - clip.left > 1 && clip.bottom - clip.top > 1).then_some(clip)
}

#[cfg(windows)]
pub(crate) unsafe fn apply_region(
    hwnd: windows::Win32::Foundation::HWND,
    width: i32,
    height: i32,
    radius: i32,
    clip: ClipRect,
    redraw: bool,
) {
    use windows::Win32::Graphics::Gdi::*;
    let rounded = CreateRoundRectRgn(0, 0, width + 1, height + 1, radius * 2, radius * 2);
    let viewport = CreateRectRgn(clip.left, clip.top, clip.right, clip.bottom);
    if rounded.is_invalid() || viewport.is_invalid() {
        if !rounded.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(rounded.0));
        }
        if !viewport.is_invalid() {
            let _ = DeleteObject(HGDIOBJ(viewport.0));
        }
        return;
    }
    let combined = CombineRgn(Some(rounded), Some(rounded), Some(viewport), RGN_AND).0 != 0;
    let _ = DeleteObject(HGDIOBJ(viewport.0));
    if !combined || SetWindowRgn(hwnd, Some(rounded), redraw) == 0 {
        let _ = DeleteObject(HGDIOBJ(rounded.0));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn bounds() -> PlayerBounds {
        PlayerBounds {
            x: 100.,
            y: 120.,
            width: 640.,
            height: 360.,
            visible: true,
            radius: Some(12.),
            viewport_top: 64.,
        }
    }
    #[test]
    fn scrolling_clips_at_header_without_hiding_or_resizing_video() {
        let mut b = bounds();
        assert_eq!(
            visible_clip(&b, (1440, 900)),
            Some(ClipRect {
                left: 0,
                top: 0,
                right: 640,
                bottom: 360
            })
        );
        b.y = -80.;
        assert_eq!(
            visible_clip(&b, (1440, 900)),
            Some(ClipRect {
                left: 0,
                top: 144,
                right: 640,
                bottom: 360
            })
        );
        b.y = -300.;
        assert!(visible_clip(&b, (1440, 900)).is_none());
    }
    #[test]
    fn clips_both_viewport_edges_and_supports_fullscreen() {
        let mut b = bounds();
        b.x = -20.;
        b.y = 700.;
        assert_eq!(
            visible_clip(&b, (600, 900)),
            Some(ClipRect {
                left: 20,
                top: 0,
                right: 620,
                bottom: 200
            })
        );
        b.x = 0.;
        b.y = 0.;
        b.viewport_top = 0.;
        assert_eq!(visible_clip(&b, (640, 360)).unwrap().top, 0);
        b.viewport_top = f64::NAN;
        assert!(visible_clip(&b, (640, 360)).is_none());
        b.viewport_top = 0.;
        b.visible = false;
        assert!(visible_clip(&b, (640, 360)).is_none());
    }
}
