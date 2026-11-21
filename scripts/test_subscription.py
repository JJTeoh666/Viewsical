"""Run with the bundled Python using -B scripts/test_subscription.py."""

import runpy
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch
from urllib.error import HTTPError


helper = runpy.run_path(str(Path(__file__).resolve().parents[1] / 'resources/ytdlp-plugins/account_actions.py'))
subscription = helper['run_subscription']
CHANNEL = 'UCuAXFkgsw1L7xaCfnd5JJOw'
OTHER = 'UCWeg2Pkate69NFdBeuRFTAw'
VIDEO = 'dQw4w9WgXcQ'


def legacy_control(state, channel=CHANNEL):
    return {'subscribeButtonRenderer': {
        'channelId': channel,
        'subscribed': state,
        'signInEndpoint': {},
        'onSubscribeEndpoints': [{'subscribeEndpoint': {'channelIds': [channel], 'params': 'provided'}}],
        'onUnsubscribeEndpoints': [{'openPopupAction': {'confirmButton': {
            'unsubscribeEndpoint': {'channelIds': [channel], 'params': 'provided'},
        }}}],
    }}


def ambiguous_control():
    return {'subscribeButtonView': {
        'channelId': CHANNEL,
        'subscribeButtonContent': {'subscribeState': {'subscribed': False}},
        'unsubscribeButtonContent': {'subscribeState': {'subscribed': True}},
    }}


def modern_control(*titles):
    actions = [{'buttonViewModel': {'title': title, 'onTap': {'innertubeCommand': {'showSheetCommand': {}}}}}
               for title in titles]
    return {'pageHeaderRenderer': {'content': {'pageHeaderViewModel': {'actions': {
        'flexibleActionsViewModel': {'actionsRows': [{'actions': actions}]},
    }}}}}


def channel_doc(header, channel=CHANNEL):
    return {'metadata': {'channelMetadataRenderer': {'externalId': channel}}, 'responseContext': {}, 'header': header}


def watch_doc(control, channel=CHANNEL, video=VIDEO):
    details = {
        'owner': {'videoOwnerRenderer': {
            'navigationEndpoint': {'browseEndpoint': {'browseId': channel}},
            'subscriptionButton': {'type': 'FREE'},
        }},
        'subscribeButton': control,
    }
    return {
        'responseContext': {},
        'currentVideoEndpoint': {'watchEndpoint': {'videoId': video}},
        'contents': {'twoColumnWatchNextResults': {'results': {
            'results': {'contents': [{'videoSecondaryInfoRenderer': details}]},
        }}},
    }


class SubscriptionTests(unittest.TestCase):
    def setUp(self):
        globals_ = subscription.__globals__
        patcher = patch.dict(globals_)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.pages = []
        self.replies = []
        self.requests = []
        self.diagnostics = []
        self.config = {'LOGGED_IN': True}
        self.downloader = SimpleNamespace(cookiejar=object())
        self.extractor = SimpleNamespace(
            is_authenticated=True,
            _download_webpage_handle=self.download,
            extract_ytcfg=lambda *_: self.config,
            extract_yt_initial_data=lambda _, data: data,
            generate_api_headers=lambda **_: {'Authorization': 'fixture-auth'},
            _extract_visitor_data=lambda *_: None,
            _extract_delegated_session_id=lambda *_: None,
            _extract_user_session_id=lambda *_: None,
            _extract_session_index=lambda *_: None,
        )
        globals_.update(
            YoutubeTabIE=lambda _: self.extractor,
            yt_dlp=SimpleNamespace(YoutubeDL=lambda _: self),
            submit_action=self.submit,
        )

    def __enter__(self):
        return self.downloader

    def __exit__(self, *_):
        pass

    def download(self, url, lookup_id, **_):
        self.requests.append(('page', lookup_id))
        return self.pages.pop(0), SimpleNamespace(status=200)

    def submit(self, _extractor, _cookies, endpoint, payload, _config, _headers, **_):
        self.requests.append((endpoint, payload))
        reply = self.replies.pop(0)
        if isinstance(reply, Exception):
            raise reply
        return reply

    def run_lookup(self, state=None, video=None):
        return subscription(CHANNEL, 'fixture-cookies.txt', state, video, self.diagnostics)

    def test_explicit_and_visible_states(self):
        for state, title in ((True, 'Subscribed'), (False, 'Subscribe')):
            with self.subTest(state=state):
                self.pages = [channel_doc(legacy_control(state)), channel_doc(modern_control(title))]
                self.assertEqual(self.run_lookup(), {'subscribed': state})
                self.assertEqual(self.run_lookup(), {'subscribed': state})

    def test_alternative_presentations_and_conflicting_controls_are_unknown(self):
        nested = ambiguous_control()
        nested['subscribeButtonView']['subscribeButtonContent'].update(legacy_control(False))
        for header in (ambiguous_control(), nested, {**legacy_control(True), **modern_control('Subscribe')}):
            self.pages = [channel_doc(header)]
            self.replies = [(channel_doc(header), 200)]
            self.assertEqual(self.run_lookup(), {'error': 'subscription_status_unavailable'})

    def test_watch_fallback_uses_verified_uploader_and_video(self):
        for document in (watch_doc(legacy_control(True), channel=OTHER),
                         watch_doc(legacy_control(True), video='abcdefghijk'),
                         watch_doc(legacy_control(True, OTHER))):
            self.pages = [channel_doc(ambiguous_control()), document]
            self.assertEqual(self.run_lookup(video=VIDEO), {'error': 'subscription_status_unavailable'})
        self.pages = [channel_doc(ambiguous_control()), watch_doc(legacy_control(True))]
        self.assertEqual(self.run_lookup(video=VIDEO), {'subscribed': True})
        self.assertEqual(self.requests[-2:], [('page', CHANNEL), ('page', VIDEO)])

    def test_profile_fallback_checks_the_channel_identity(self):
        self.pages = [channel_doc(ambiguous_control()), channel_doc(ambiguous_control())]
        self.replies = [(channel_doc(legacy_control(True), OTHER), 200), (channel_doc(legacy_control(False)), 200)]
        self.assertEqual(self.run_lookup(), {'error': 'subscription_status_unavailable'})
        self.assertEqual(self.run_lookup(), {'subscribed': False})
        self.assertEqual(self.requests[-1], ('browse', {'browseId': CHANNEL}))

    def test_signed_out_prohibits_a_write(self):
        self.pages = [channel_doc(legacy_control(False))]
        self.config['LOGGED_IN'] = False
        self.assertEqual(self.run_lookup(True), {'error': 'sign_in_required'})
        self.assertEqual(self.requests, [('page', CHANNEL)])
        self.assertEqual(self.diagnostics[-1], {'stage': 'channel', 'shape': 'signed_out', 'httpStatus': 200})

    def test_signed_out_fallback_does_not_report_state(self):
        document = channel_doc(legacy_control(True))
        document['responseContext'] = {'mainAppWebResponseContext': {'loggedOut': True}}
        self.pages = [channel_doc(ambiguous_control())]
        self.replies = [(document, 200)]
        self.assertEqual(self.run_lookup(), {'error': 'sign_in_required'})

    def test_already_in_requested_state_and_missing_command_never_write(self):
        self.pages = [channel_doc(legacy_control(True)), channel_doc(modern_control('Subscribed'))]
        self.replies = [(channel_doc(modern_control('Subscribed')), 200)]
        self.assertEqual(self.run_lookup(True), {'subscribed': True})
        self.assertEqual(self.run_lookup(False), {'error': 'subscription_write_rejected'})
        self.assertEqual(self.requests, [('page', CHANNEL), ('page', CHANNEL), ('browse', {'browseId': CHANNEL})])

    def test_exact_channel_action_confirms_once(self):
        self.pages = [channel_doc(legacy_control(True))]
        self.replies = [({'responseContext': {}, 'actions': [
            {'updateSubscribeButtonAction': {'channelId': CHANNEL, 'subscribed': False}},
        ]}, 200)]
        self.assertEqual(self.run_lookup(False), {'subscribed': False})
        self.assertEqual(self.requests, [
            ('page', CHANNEL), ('subscription/unsubscribe', {'channelIds': [CHANNEL], 'params': 'provided'}),
        ])

    def test_write_timeout_rechecks_the_same_source_without_repeating_the_write(self):
        self.pages = [channel_doc(ambiguous_control()), watch_doc(legacy_control(False)), watch_doc(legacy_control(True))]
        self.replies = [TimeoutError()]
        self.assertEqual(self.run_lookup(True, video=VIDEO), {'subscribed': True})
        self.assertEqual(self.requests, [
            ('page', CHANNEL), ('page', VIDEO),
            ('subscription/subscribe', {'channelIds': [CHANNEL], 'params': 'provided'}), ('page', VIDEO),
        ])
        self.assertEqual(self.diagnostics[-1]['stage'], 'confirm')

    def test_wrong_channel_in_write_reply_requires_readback(self):
        self.pages = [channel_doc(legacy_control(False)), channel_doc(legacy_control(False))]
        self.replies = [({'responseContext': {}, 'actions': [
            {'updateSubscribeButtonAction': {'channelId': OTHER, 'subscribed': True}},
        ]}, 200)]
        self.assertEqual(self.run_lookup(True), {'error': 'subscription_confirmation_pending'})
        self.assertEqual([name for name, _ in self.requests], ['page', 'subscription/subscribe', 'page'])

    def test_http_rejection_is_distinct_from_an_unconfirmed_change(self):
        self.pages = [channel_doc(legacy_control(False))]
        self.replies = [HTTPError('https://www.youtube.com', 403, 'fixture rejection', {}, None)]
        self.assertEqual(self.run_lookup(True), {'error': 'subscription_write_rejected'})
        self.assertEqual(self.diagnostics[-1], {'stage': 'write', 'shape': 'rejected', 'httpStatus': 403})


if __name__ == '__main__':
    unittest.main()
