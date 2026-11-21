"""Manage ratings, subscriptions, and playlist membership with the app-owned YouTube session."""

import json
import re
import sys
from dataclasses import dataclass
from urllib.parse import urlencode
from urllib.error import HTTPError
from urllib.request import HTTPCookieProcessor, HTTPRedirectHandler, Request, build_opener

import yt_dlp
from yt_dlp.extractor.youtube import YoutubeIE, YoutubeTabIE
from yt_dlp.utils import ExtractorError
from yt_dlp.utils.traversal import traverse_obj


RATING_STATUS = {'LIKE': 'like', 'DISLIKE': 'dislike', 'INDIFFERENT': 'none'}
ACTION = {
    'like': ('like/like', 'LIKE', 'likeParams'),
    'dislike': ('like/dislike', 'DISLIKE', 'dislikeParams'),
    'none': ('like/removelike', 'INDIFFERENT', 'removeLikeParams'),
}


class QuietLog:
    def debug(self, _message):
        pass

    info = warning = error = debug


class NoRedirects(HTTPRedirectHandler):
    def redirect_request(self, *_args):
        return None


def submit_action(extractor, cookie_jar, endpoint, payload, config, headers, *,
                  timeout=6, with_status=False, limit=256 * 1024):
    # An account operation only goes to the fixed YouTube origin. Never forward
    # its Authorization header to a response-supplied redirect target.
    options = {'prettyPrint': 'false'}
    if isinstance(config.get('INNERTUBE_API_KEY'), str):
        options['key'] = config['INNERTUBE_API_KEY']
    body = {'context': extractor._extract_context(config), **payload}
    url = f'https://www.youtube.com/youtubei/v1/{endpoint}?{urlencode(options)}'
    request = Request(url, data=json.dumps(body).encode('utf-8'), headers={
        **{name: str(value) for name, value in headers.items()},
        'Content-Type': 'application/json',
    })
    opener = build_opener(NoRedirects(), HTTPCookieProcessor(cookie_jar))
    with opener.open(request, timeout=timeout) as response:
        data = response.read(limit + 1)
        status = response.status
    try:
        document = json.loads(data) if len(data) <= limit else None
    except ValueError:
        if not with_status:
            raise
        document = None
    return (document, status) if with_status else document


def rating_controls(data):
    """Use only the current video's action bar, excluding recommendation cards."""
    buttons = traverse_obj(data, (
        'contents', 'twoColumnWatchNextResults', 'results', 'results', 'contents', ...,
        'videoPrimaryInfoRenderer', 'videoActions', 'menuRenderer', 'topLevelButtons', ...,
        {dict},
    ))
    for button in buttons:
        modern = button.get('segmentedLikeDislikeButtonViewModel')
        if isinstance(modern, dict):
            models = [traverse_obj(modern, (name, name, {dict})) or {}
                      for name in ('likeButtonViewModel', 'dislikeButtonViewModel')]
            for model in models:
                status = traverse_obj(model, ('likeStatusEntity', 'likeStatus', {str}))
                if status in RATING_STATUS:
                    return RATING_STATUS[status], models, True
        legacy = button.get('segmentedLikeDislikeButtonRenderer')
        if isinstance(legacy, dict):
            models = [traverse_obj(legacy, (name, 'toggleButtonRenderer', {dict})) or {}
                      for name in ('likeButton', 'dislikeButton')]
            states = [model.get('isToggled') for model in models]
            if all(isinstance(state, bool) for state in states) and states != [True, True]:
                status = 'like' if states[0] else 'dislike' if states[1] else 'none'
                return status, models, False
    return None, [], False


def rating_action(models, modern, current, desired, video_id):
    endpoint, status, params = ACTION[desired]
    model = models[1 if (current if desired == 'none' else desired) == 'dislike' else 0]
    if modern:
        toggle = traverse_obj(model, ('toggleButtonViewModel', 'toggleButtonViewModel', {dict})) or {}
        if toggle.get('isTogglingDisabled'):
            return None
        button = 'toggledButtonViewModel' if desired == 'none' else 'defaultButtonViewModel'
        tap = traverse_obj(toggle, (button, 'buttonViewModel', 'onTap', {dict}))
        commands = traverse_obj(tap, ((('serialCommand', 'commands', ..., 'innertubeCommand'),
                                       'innertubeCommand'), {dict}))
    else:
        button = 'toggledServiceEndpoint' if desired == 'none' else 'defaultServiceEndpoint'
        commands = [model.get(button) or {}]
    for command in commands:
        api_path = traverse_obj(command, ('commandMetadata', 'webCommandMetadata', 'apiUrl', {str}))
        like = traverse_obj(command, ('likeEndpoint', {dict})) or {}
        if (api_path != f'/youtubei/v1/{endpoint}' or like.get('status') != status
                or traverse_obj(like, ('target', 'videoId')) != video_id):
            continue
        query = {'target': {'videoId': video_id}, 'status': status}
        if isinstance(like.get(params), str) and len(like[params]) <= 4096:
            query[params] = like[params]
        tracking = command.get('clickTrackingParams')
        if isinstance(tracking, str) and len(tracking) <= 4096:
            query['clickTracking'] = {'clickTrackingParams': tracking}
        return endpoint, query
    return None


def run(video_id, cookie_path, desired):
    with yt_dlp.YoutubeDL({'cookiefile': cookie_path, 'socket_timeout': 6, 'logger': QuietLog()}) as downloader:
        extractor = YoutubeIE(downloader)
        if not extractor.is_authenticated:
            return {'error': 'sign_in_required'}
        url = f'https://www.youtube.com/watch?v={video_id}'
        webpage = extractor._download_webpage(url, video_id, query={'hl': 'en'})
        config = extractor.extract_ytcfg(video_id, webpage)
        if config.get('LOGGED_IN') is not True:
            return {'error': 'sign_in_required'}
        data = extractor.extract_yt_initial_data(video_id, webpage)
        watched_id = traverse_obj(data, ('currentVideoEndpoint', 'watchEndpoint', 'videoId'))
        if watched_id != video_id:
            return {'error': 'rating_unavailable'}
        current, models, modern = rating_controls(data)
        if current is None:
            return {'error': 'rating_unavailable'}
        if desired is None or desired == current:
            return {'rating': current}
        action = rating_action(models, modern, current, desired, video_id)
        if action is None:
            return {'error': 'rating_unavailable'}
        endpoint, query = action
        headers = extractor.generate_api_headers(ytcfg=config, visitor_data=extractor._extract_visitor_data(data, config))
        if not headers.get('Authorization'):
            return {'error': 'sign_in_required'}
        headers['Referer'] = url
        response = submit_action(extractor, downloader.cookiejar, endpoint, query, config, headers)
        if not isinstance(response, dict) or 'error' in response or 'responseContext' not in response:
            return {'error': 'rating_unavailable'}
        if traverse_obj(response, ('responseContext', 'mainAppWebResponseContext', 'loggedOut')) is True:
            return {'error': 'sign_in_required'}
        return {'rating': desired}


def descendants(value, key):
    """Look through bounded first-party response subtrees for renderer nodes."""
    pending = [value]
    while pending:
        value = pending.pop()
        if isinstance(value, dict):
            if key in value:
                yield value[key]
            pending.extend(reversed(value.values()))
        elif isinstance(value, list):
            pending.extend(reversed(value))


SIGN_IN_KEYS = (
    'signInEndpoint', 'signInCommand', 'signInButton', 'showSignInDialogCommand', 'signInModalRenderer',
)
SUBSCRIPTION_VIEWS = ('subscribeButtonRenderer', 'subscribeButtonViewModel', 'subscribeButtonView')
SUBSCRIPTION_READ_TIMEOUT = 4
SUBSCRIPTION_WRITE_TIMEOUT = 3


def signed_out(data):
    return traverse_obj(data, ('responseContext', 'mainAppWebResponseContext', 'loggedOut')) is True


def matching_control(button, channel_id):
    if not isinstance(button, dict) or button.get('isSignedOut') is True:
        return False
    if button.get('channelId', channel_id) != channel_id:
        return False
    return all(
        endpoint.get('channelIds') == [channel_id]
        for key in ('subscribeEndpoint', 'unsubscribeEndpoint')
        for endpoint in descendants(button, key)
        if isinstance(endpoint, dict)
    )


def dedicated_controls(scope):
    pending = [scope]
    while pending:
        value = pending.pop()
        if isinstance(value, list):
            pending.extend(reversed(value))
        elif isinstance(value, dict):
            for key, child in value.items():
                if key in SUBSCRIPTION_VIEWS:
                    yield child
                elif key not in ('subscribeButtonContent', 'unsubscribeButtonContent'):
                    pending.append(child)


def read_controls(scope, visible_buttons, channel_id):
    """Return the verified controls and their active state, if unambiguous."""
    dedicated = [button for button in dedicated_controls(scope) if matching_control(button, channel_id)]
    visible = [
        button for button in visible_buttons
        if matching_control(button, channel_id)
        and isinstance(button.get('onTap'), dict) and button['onTap']
        and not any(True for key in SIGN_IN_KEYS for _ in descendants(button['onTap'], key))
        and button.get('state') not in ('BUTTON_STATE_DISABLED', 'BUTTON_STATE_HIDDEN')
        and button.get('title') in ('Subscribe', 'Subscribed')
    ]
    states = set()
    ambiguous_variants = False
    for button in dedicated:
        explicit = (
            button.get('subscribed'), button.get('isSubscribed'),
            traverse_obj(button, ('subscribeState', 'subscribed')),
        )
        if any(isinstance(state, bool) for state in explicit):
            states.update(state for state in explicit if isinstance(state, bool))
            continue
        variants = [traverse_obj(button, (name, 'subscribeState', 'subscribed'))
                    for name in ('subscribeButtonContent', 'unsubscribeButtonContent')]
        # A pair with opposite values describes two presentations. It says nothing
        # about which presentation the current session is showing.
        if isinstance(variants[0], bool) and variants[0] is variants[1]:
            states.add(variants[0])
        elif all(isinstance(value, bool) for value in variants):
            ambiguous_variants = True
    explicit_state = bool(states)
    states.update(button['title'] == 'Subscribed' for button in visible)
    if len(states) == 1:
        return dedicated + visible, states.pop(), 'explicit_state' if explicit_state else 'visible_state'
    if states:
        shape = 'conflicting_controls'
    elif ambiguous_variants:
        shape = 'ambiguous_variants'
    else:
        shape = 'unknown_control' if dedicated else 'missing_control'
    return dedicated + visible, None, shape


def channel_controls(header, channel_id):
    visible = traverse_obj(header, (
        'pageHeaderRenderer', 'content', 'pageHeaderViewModel', 'actions',
        'flexibleActionsViewModel', 'actionsRows', ..., 'actions', ..., 'buttonViewModel', {dict},
    ))
    return read_controls(header, visible, channel_id)


def subscription_state(header, channel_id):
    return channel_controls(header, channel_id)[1]


def watch_controls(data, video_id, channel_id):
    if traverse_obj(data, ('currentVideoEndpoint', 'watchEndpoint', 'videoId')) != video_id:
        return None
    details = traverse_obj(data, (
        'contents', 'twoColumnWatchNextResults', 'results', 'results', 'contents', ...,
        'videoSecondaryInfoRenderer', {dict},
    ))
    if len(details) != 1 or traverse_obj(details[0], (
        'owner', 'videoOwnerRenderer', 'navigationEndpoint', 'browseEndpoint', 'browseId',
    )) != channel_id:
        return None
    scopes = [
        details[0].get('subscribeButton'),
        traverse_obj(details[0], ('owner', 'videoOwnerRenderer', 'subscriptionButton', {dict})),
    ]
    visible = traverse_obj(scopes, (..., 'buttonViewModel', {dict}))
    return read_controls(scopes, visible, channel_id)


def subscription_payload(controls, channel_id, desired):
    action = 'subscribe' if desired else 'unsubscribe'
    for control in controls:
        if control.get('disableSubscribeButton') is True or control.get('enabled') is False:
            continue
        for details in descendants(control, action + 'Endpoint'):
            if isinstance(details, dict) and details.get('channelIds') == [channel_id]:
                payload = {'channelIds': [channel_id]}
                if isinstance(details.get('params'), str) and len(details['params']) <= 4096:
                    payload['params'] = details['params']
                return f'subscription/{action}', payload
    return None


@dataclass
class SubscriptionRead:
    source: str
    config: dict
    data: dict
    url: str
    controls: list
    state: bool | None


def request_status(error):
    cause = error.cause if isinstance(error, ExtractorError) else error
    return next((status for status in (getattr(cause, 'status', None), getattr(cause, 'code', None))
                 if type(status) is int and 100 <= status <= 599), None)


def run_subscription(channel_id, cookie_path, desired, video_id, diagnostics):
    unavailable = {'error': 'subscription_status_unavailable'}
    reauthenticate = {'error': 'sign_in_required'}
    rejected = {'error': 'subscription_write_rejected'}
    unconfirmed = {'error': 'subscription_confirmation_pending'}
    channel_url = f'https://www.youtube.com/channel/{channel_id}/featured'
    watch_url = f'https://www.youtube.com/watch?v={video_id}'

    def record(stage, shape, status=None):
        diagnostics.append({'stage': stage, 'shape': shape, 'httpStatus': status})

    with yt_dlp.YoutubeDL({
        'cookiefile': cookie_path, 'socket_timeout': SUBSCRIPTION_READ_TIMEOUT, 'logger': QuietLog(),
    }) as downloader:
        extractor = YoutubeTabIE(downloader)
        if not extractor.is_authenticated:
            record('channel', 'signed_out')
            return reauthenticate

        def headers_for(read):
            headers = extractor.generate_api_headers(
                ytcfg=read.config, visitor_data=extractor._extract_visitor_data(read.data, read.config),
                delegated_session_id=extractor._extract_delegated_session_id(read.config, read.data),
                user_session_id=extractor._extract_user_session_id(read.config, read.data),
                session_index=extractor._extract_session_index(read.config, read.data),
            )
            headers['Referer'] = read.url
            return headers

        def read_status(source, previous=None, *, stage):
            lookup_id = video_id if source == 'watch' else channel_id
            url = watch_url if source == 'watch' else channel_url
            status = None
            try:
                if source == 'browse':
                    config = previous.config
                    headers = headers_for(previous)
                    if not headers.get('Authorization'):
                        record(stage, 'signed_out')
                        return reauthenticate
                    data, status = submit_action(
                        extractor, downloader.cookiejar, 'browse', {'browseId': channel_id}, config, headers,
                        timeout=SUBSCRIPTION_READ_TIMEOUT, with_status=True, limit=2 * 1024 * 1024,
                    )
                else:
                    webpage, response = extractor._download_webpage_handle(url, lookup_id, query={'hl': 'en'})
                    status = response.status
                    config = extractor.extract_ytcfg(lookup_id, webpage)
                    if config.get('LOGGED_IN') is not True:
                        logged_out = config.get('LOGGED_IN') is False
                        record(stage, 'signed_out' if logged_out else 'unrecognized_document', status)
                        return reauthenticate if logged_out else unavailable
                    data = extractor.extract_yt_initial_data(lookup_id, webpage)
            except (OSError, ExtractorError, ValueError) as error:
                error_status = request_status(error)
                if error_status == 401:
                    record(stage, 'signed_out', error_status)
                    return reauthenticate
                record(stage, 'unrecognized_document' if status is not None else 'request_failed', error_status or status)
                return unavailable
            if signed_out(data):
                record(stage, 'signed_out', status)
                return reauthenticate
            if (not isinstance(data, dict) or 'error' in data
                    or source == 'browse' and not isinstance(data.get('responseContext'), dict)):
                record(stage, 'unrecognized_document', status)
                return unavailable
            if source == 'watch':
                parsed = watch_controls(data, video_id, channel_id)
            else:
                returned_id = traverse_obj(data, ('metadata', 'channelMetadataRenderer', 'externalId'))
                parsed = channel_controls(data.get('header'), channel_id) if returned_id == channel_id else None
            if parsed is None:
                record(stage, 'unexpected_identity', status)
                return unavailable
            controls, current, shape = parsed
            record(stage, shape, status)
            return SubscriptionRead(source, config, data, url, controls, current)

        read = read_status('channel', stage='channel')
        if not isinstance(read, SubscriptionRead):
            return read
        action = subscription_payload(read.controls, channel_id, desired) if desired is not None else None
        if read.state is None or (desired is not None and read.state != desired and action is None):
            alternate = read_status('watch' if video_id else 'browse', read, stage='fallback')
            if alternate == reauthenticate:
                return alternate
            if isinstance(alternate, SubscriptionRead) and alternate.state is not None:
                read = alternate
                action = subscription_payload(read.controls, channel_id, desired) if desired is not None else None
        if read.state is None:
            return unavailable
        if desired is None or read.state == desired:
            return {'subscribed': read.state}
        if action is None:
            record('write', 'action_missing')
            return rejected
        headers = headers_for(read)
        if not headers.get('Authorization'):
            record('write', 'signed_out')
            return reauthenticate
        try:
            endpoint, payload = action
            response, status = submit_action(
                extractor, downloader.cookiejar, endpoint, payload, read.config, headers,
                timeout=SUBSCRIPTION_WRITE_TIMEOUT, with_status=True,
            )
        except (OSError, ValueError) as error:
            response, status = None, request_status(error)
        if status == 401 or signed_out(response):
            record('write', 'signed_out', status)
            return reauthenticate
        error_status = traverse_obj(response, ('error', 'code', {int}))
        if error_status == 401:
            record('write', 'signed_out', status)
            return reauthenticate
        if any(code is not None and 400 <= code < 500 and code not in (408, 409)
               for code in (status, error_status)):
            record('write', 'rejected', status)
            return rejected
        if isinstance(response, dict) and isinstance(response.get('responseContext'), dict):
            states = {
                update['subscribed'] for update in descendants(response, 'updateSubscribeButtonAction')
                if isinstance(update, dict) and update.get('channelId') == channel_id
                and isinstance(update.get('subscribed'), bool)
            }
            if states == {desired}:
                record('write', 'confirmed', status)
                return {'subscribed': desired}
        record('write', 'unconfirmed', status)
        confirmation = read_status(read.source, read, stage='confirm')
        if isinstance(confirmation, SubscriptionRead) and confirmation.state is desired:
            return {'subscribed': desired}
        if confirmation == reauthenticate:
            return confirmation
        record('confirm', 'unconfirmed')
        return unconfirmed


def playlist_options(response):
    rows = traverse_obj(response, ('contents', ..., 'addToPlaylistRenderer', 'playlists', {list}), get_all=False)
    if rows is None:
        return None
    options = {}
    for row in traverse_obj(rows, (..., 'playlistAddToOptionRenderer', {dict})):
        playlist_id = row.get('playlistId')
        selected = row.get('containsSelectedVideos')
        title = row.get('title', {})
        title = traverse_obj(title, ('simpleText', {str})) or ''.join(
            traverse_obj(title, ('runs', ..., 'text', {str})))
        if (isinstance(playlist_id, str) and re.fullmatch(r'[\w-]{2,128}', playlist_id, re.ASCII)
                and selected in ('ALL', 'NONE') and title.strip()):
            options[playlist_id] = {'id': playlist_id, 'title': title.strip()[:200], 'saved': selected == 'ALL'}
    return options


def run_playlist(video_id, cookie_path, playlist_id):
    unavailable = {'error': 'playlist_save_unavailable'}
    signed_out = {'error': 'sign_in_required'}
    with yt_dlp.YoutubeDL({'cookiefile': cookie_path, 'socket_timeout': 6, 'logger': QuietLog()}) as downloader:
        extractor = YoutubeIE(downloader)
        if not extractor.is_authenticated:
            return signed_out
        url = f'https://www.youtube.com/watch?v={video_id}'
        webpage = extractor._download_webpage(url, video_id, query={'hl': 'en'})
        config = extractor.extract_ytcfg(video_id, webpage)
        if config.get('LOGGED_IN') is not True:
            return signed_out
        data = extractor.extract_yt_initial_data(video_id, webpage)
        if traverse_obj(data, ('currentVideoEndpoint', 'watchEndpoint', 'videoId')) != video_id:
            return unavailable
        headers = extractor.generate_api_headers(ytcfg=config, visitor_data=extractor._extract_visitor_data(data, config))
        if not headers.get('Authorization'):
            return signed_out
        headers['Referer'] = url

        def request(endpoint, body):
            return submit_action(extractor, downloader.cookiejar, endpoint, body, config, headers)

        def read_options():
            return request('playlist/get_add_to_playlist', {'videoIds': [video_id], 'excludeWatchLater': False})

        response = read_options()
        if traverse_obj(response, ('responseContext', 'mainAppWebResponseContext', 'loggedOut')) is True:
            return signed_out
        if not isinstance(response, dict) or 'error' in response:
            return unavailable
        options = playlist_options(response)
        if options is None:
            return unavailable
        if playlist_id is None:
            return {'playlists': list(options.values())}
        option = options.get(playlist_id)
        if option is None:
            return unavailable
        if option['saved']:
            return {'saved': True}
        result = request('browse/edit_playlist', {
            'playlistId': playlist_id,
            'actions': [{'action': 'ACTION_ADD_VIDEO', 'addedVideoId': video_id}],
        })
        if traverse_obj(result, ('responseContext', 'mainAppWebResponseContext', 'loggedOut')) is True:
            return signed_out
        if isinstance(result, dict) and result.get('status') == 'STATUS_SUCCEEDED':
            return {'saved': True}
        if isinstance(result, dict) and 'error' not in result and 'responseContext' in result:
            confirmed = playlist_options(read_options()) or {}
            if (confirmed.get(playlist_id) or {}).get('saved'):
                return {'saved': True}
        return unavailable


if __name__ == '__main__':
    request = {}
    diagnostics = []
    failure = 'rating_unavailable'
    try:
        request = json.load(sys.stdin)
        path = request['cookiePath']
        if 'channelId' in request:
            channel = request['channelId']
            desired = request.get('subscribed')
            video = request.get('videoId')
            failure = 'subscription_status_unavailable' if desired is None else 'subscription_confirmation_pending'
            if (not re.fullmatch(r'UC[A-Za-z0-9_-]{22}', channel)
                    or (desired is not None and not isinstance(desired, bool))
                    or (video is not None and not re.fullmatch(r'[A-Za-z0-9_-]{11}', video))):
                raise ValueError('Invalid subscription request')
            result = run_subscription(channel, path, desired, video, diagnostics)
        elif 'playlistId' in request:
            failure = 'playlist_save_unavailable'
            video = request['videoId']
            playlist = request['playlistId']
            if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video) or (
                    playlist is not None and not re.fullmatch(r'[A-Za-z0-9_-]{2,128}', playlist)):
                raise ValueError('Invalid playlist request')
            result = run_playlist(video, path, playlist)
        else:
            video = request['videoId']
            desired = request.get('rating')
            if not re.fullmatch(r'[A-Za-z0-9_-]{11}', video) or (desired is not None and desired not in ACTION):
                raise ValueError('Invalid rating request')
            result = run(video, path, desired)
    except Exception:
        result = {'error': failure}
        if 'channelId' in request:
            diagnostics.append({'stage': 'helper', 'shape': 'unexpected_error', 'httpStatus': None})
    if diagnostics:
        result['diagnostics'] = diagnostics
    print(json.dumps(result))
