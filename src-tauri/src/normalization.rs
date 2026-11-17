//! Playback-only YouTube gain. Keep it separate from mpv's user-volume curve.
//! The conservative headroom policy attenuates loud material; it never boosts.
pub fn valid_loudness(value: Option<f64>) -> Option<f64> {
    value.filter(|db| db.is_finite() && (-100. ..=100.).contains(db))
}

pub fn gain_db(enabled: bool, loudness_db: Option<f64>) -> f64 {
    if !enabled {
        return 0.;
    }
    // Equivalent to clamp(10^(-loudness/20), 0.1, 1.0), expressed in dB
    // because mpv volume-gain applies amplitude gain independently of volume.
    valid_loudness(loudness_db).map_or(0., |db| (-db).clamp(-20., 0.))
}

pub fn enabled_by_default() -> bool {
    true
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn youtube_sign_and_amplitude_are_correct() {
        let gain = gain_db(true, Some(6.));
        assert_eq!(gain, -6.);
        assert!((10f64.powf(gain / 20.) - 0.501187).abs() < 0.000001);
    }

    #[test]
    fn neutral_missing_disabled_and_invalid_values_do_not_retain_gain() {
        for value in [
            None,
            Some(f64::NAN),
            Some(f64::INFINITY),
            Some(-101.),
            Some(101.),
        ] {
            assert_eq!(gain_db(true, value), 0.);
        }
        assert_eq!(gain_db(false, Some(6.)), 0.);
        assert_eq!(gain_db(true, Some(0.)), 0.);
    }

    #[test]
    fn headroom_policy_never_boosts_and_caps_attenuation() {
        assert_eq!(gain_db(true, Some(-4.)), 0.);
        assert_eq!(gain_db(true, Some(40.)), -20.);
        assert_eq!(gain_db(true, Some(3.)), -3.);
    }
}
