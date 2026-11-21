"""Manage ratings, subscriptions, and playlist membership with the app-owned YouTube session."""

import json
import re
import sys
from urllib.parse import urlencode
from urllib.request import HTTPCookieProcessor, HTTPRedirectHandler, Request, build_opener

import yt_dlp
from yt_dlp.extractor.youtube import YoutubeIE, YoutubeTabIE
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


def submit_action(extractor, cookie_jar, endpoint, payload, config, headers):
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
    with opener.open(request, timeout=6) as response:
        data = response.read(256 * 1024 + 1)
    return json.loads(data) if len(data) <= 256 * 1024 else None


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


def subscription_state(header, channel_id):
    for kind in ('subscribeButtonRenderer', 'subscribeButtonViewModel', 'subscribeButtonView'):
        for button in descendants(header, kind):
            if (not isinstance(button, dict) or button.get('channelId') != channel_id
                    or button.get('isSignedOut') is True):
                continue
            for state in (button.get('subscribed'), button.get('isSubscribed'),
                          traverse_obj(button, ('subscribeState', 'subscribed'))):
                if isinstance(state, bool):
                    return state
            # The two button presentations can describe opposite states.
            # Only treat them as current state when their values agree.
            subscribe_state = traverse_obj(button, ('subscribeButtonContent', 'subscribeState', 'subscribed'))
            unsubscribe_state = traverse_obj(button, ('unsubscribeButtonContent', 'subscribeState', 'subscribed'))
            if isinstance(subscribe_state, bool) and subscribe_state is unsubscribe_state:
                return subscribe_state
    # Some variants put the currently visible action in a plain button.
    for button in descendants(header, 'buttonViewModel'):
        if not isinstance(button, dict) or button.get('title') not in ('Subscribe', 'Subscribed'):
            continue
        action_found = any(
            isinstance(action, dict) and action.get('channelIds') == [channel_id]
            for key in ('subscribeEndpoint', 'unsubscribeEndpoint')
            for action in descendants(button.get('onTap'), key)
        )
        if action_found:
            return button['title'] == 'Subscribed'
    return None


def subscription_payload(header, channel_id, desired):
    action = 'subscribe' if desired else 'unsubscribe'
    endpoint = f'subscription/{action}'
    # Defaults from the YouTube.js InteractionManager when the view omits a command.
    payload = {'channelIds': [channel_id], 'params': 'EgIIAhgA' if desired else 'CgIIAhgA'}
    for details in descendants(header, action + 'Endpoint'):
        if isinstance(details, dict) and details.get('channelIds') == [channel_id]:
            if isinstance(details.get('params'), str) and len(details['params']) <= 4096:
                payload['params'] = details['params']
            break
    return endpoint, payload


def run_subscription(channel_id, cookie_path, desired):
    unavailable = {'error': 'subscription_unavailable'}
    with yt_dlp.YoutubeDL({'cookiefile': cookie_path, 'socket_timeout': 6, 'logger': QuietLog()}) as downloader:
        extractor = YoutubeTabIE(downloader)
        if not extractor.is_authenticated:
            return {'error': 'sign_in_required'}
        url = f'https://www.youtube.com/channel/{channel_id}/featured'

        def channel_document():
            webpage = extractor._download_webpage(url, channel_id, query={'hl': 'en'})
            config = extractor.extract_ytcfg(channel_id, webpage)
            if config.get('LOGGED_IN') is not True:
                return config, None
            data = extractor.extract_yt_initial_data(channel_id, webpage)
            returned_id = traverse_obj(data, ('metadata', 'channelMetadataRenderer', 'externalId'))
            return config, data if returned_id == channel_id else None

        config, data = channel_document()
        if config.get('LOGGED_IN') is not True:
            return {'error': 'sign_in_required'}
        if not data:
            return unavailable
        header = data.get('header')
        current = subscription_state(header, channel_id)
        if current is None:
            return unavailable
        if desired is None or current == desired:
            return {'subscribed': current}
        endpoint, payload = subscription_payload(header, channel_id, desired)
        headers = extractor.generate_api_headers(ytcfg=config, visitor_data=extractor._extract_visitor_data(data, config))
        if not headers.get('Authorization'):
            return {'error': 'sign_in_required'}
        headers['Referer'] = url
        response = submit_action(extractor, downloader.cookiejar, endpoint, payload, config, headers)
        if not isinstance(response, dict) or 'error' in response or 'responseContext' not in response:
            return unavailable
        if traverse_obj(response, ('responseContext', 'mainAppWebResponseContext', 'loggedOut')) is True:
            return {'error': 'sign_in_required'}
        for update in descendants(response, 'updateSubscribeButtonAction'):
            if isinstance(update, dict) and update.get('channelId') == channel_id and update.get('subscribed') is desired:
                return {'subscribed': desired}
        config, data = channel_document()
        if config.get('LOGGED_IN') is not True:
            return {'error': 'sign_in_required'}
        if data and subscription_state(data.get('header'), channel_id) is desired:
            return {'subscribed': desired}
        return unavailable


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
    failure = 'rating_unavailable'
    try:
        request = json.load(sys.stdin)
        path = request['cookiePath']
        if 'channelId' in request:
            failure = 'subscription_unavailable'
            channel = request['channelId']
            desired = request.get('subscribed')
            if not re.fullmatch(r'UC[A-Za-z0-9_-]{22}', channel) or (desired is not None and not isinstance(desired, bool)):
                raise ValueError('Invalid subscription request')
            result = run_subscription(channel, path, desired)
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
    print(json.dumps(result))
