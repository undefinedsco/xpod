include_guard(GLOBAL)

function(xpod_qlever_collect_runtime_link_items output_variable build_dir)
  if(NOT build_dir)
    message(FATAL_ERROR "A QLever build tree is required to derive runtime link items")
  endif()

  get_filename_component(qlever_build_dir "${build_dir}" ABSOLUTE)
  set(server_link_file
    "${qlever_build_dir}/CMakeFiles/qlever-server.dir/link.txt")
  if(NOT EXISTS "${server_link_file}")
    message(FATAL_ERROR
      "qlever-server link line is required to link the QLever runtime: ${server_link_file}")
  endif()

  file(READ "${server_link_file}" server_link_text)
  separate_arguments(server_link_tokens UNIX_COMMAND "${server_link_text}")
  set(runtime_link_items "")
  set(expect_link_search_path OFF)
  foreach(link_token IN LISTS server_link_tokens)
    if(expect_link_search_path)
      if(IS_ABSOLUTE "${link_token}")
        set(link_search_path "${link_token}")
      else()
        set(link_search_path "${qlever_build_dir}/${link_token}")
      endif()
      list(APPEND runtime_link_items "-L${link_search_path}")
      set(expect_link_search_path OFF)
    elseif(link_token STREQUAL "-L")
      set(expect_link_search_path ON)
    elseif(link_token MATCHES "^-L(.+)")
      set(link_search_path "${CMAKE_MATCH_1}")
      if(NOT IS_ABSOLUTE "${link_search_path}")
        set(link_search_path "${qlever_build_dir}/${link_search_path}")
      endif()
      list(APPEND runtime_link_items "-L${link_search_path}")
    elseif(link_token MATCHES "libserver\\.a$" OR
           link_token MATCHES "libcompilationInfo\\.a$")
      continue()
    elseif(link_token MATCHES "\\.a$" OR
           link_token MATCHES "\\.so($|\\.)" OR
           link_token MATCHES "\\.dylib$" OR
           link_token MATCHES "\\.tbd$")
      if(IS_ABSOLUTE "${link_token}")
        list(APPEND runtime_link_items "${link_token}")
      else()
        list(APPEND runtime_link_items "${qlever_build_dir}/${link_token}")
      endif()
    elseif(link_token MATCHES "^-l" OR
           link_token MATCHES "^-Wl," OR
           link_token MATCHES "^-pthread")
      list(APPEND runtime_link_items "${link_token}")
    endif()
  endforeach()

  if(expect_link_search_path)
    message(FATAL_ERROR "qlever-server link line ends with a bare -L option")
  endif()
  if(NOT runtime_link_items)
    message(FATAL_ERROR
      "Could not derive QLever runtime libraries from ${server_link_file}")
  endif()

  set(${output_variable} "${runtime_link_items}" PARENT_SCOPE)
endfunction()
